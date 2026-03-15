/**
 * Lazy browser pool with warm context management.
 *
 * - Browser launches on first use, stays warm
 * - Auto-shutdown after IDLE_TIMEOUT_MS of inactivity (only when no pages are open)
 * - Cookies/localStorage injected on context creation
 * - Stability script injected via addInitScript on every page
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { STABILITY_SCRIPT } from './stability.js';
import { loadAuth, type AuthConfig } from './auth.js';
import { log } from './log.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let authConfig: AuthConfig | null = null;

// BUG-001: Mutex promises to prevent concurrent launches
let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;

// BUG-004: Track active pages to prevent idle shutdown during work
let activePageCount = 0;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  // BUG-004: Don't set idle timer while pages are open
  if (activePageCount > 0) return;
  idleTimer = setTimeout(() => {
    log('idle timer fired, shutting down browser');
    // BUG-022: Handle async shutdown errors
    shutdown().catch((err) => log(`idle shutdown error: ${err instanceof Error ? err.message : String(err)}`));
  }, IDLE_TIMEOUT_MS);
}

// BUG-002: Validate URL scheme — only http/https allowed
export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are supported, got: ${parsed.protocol}`);
  }
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    log('reusing existing browser');
    resetIdleTimer();
    return browser;
  }

  // BUG-001: Use a mutex promise to prevent concurrent launches
  if (browserPromise) {
    log('waiting for in-flight browser launch');
    return browserPromise;
  }

  browserPromise = (async () => {
    log('launching new chromium browser');
    const launchStart = Date.now();
    const b = await chromium.launch({
      headless: true,
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
      ],
    });
    log(`browser launched in ${Date.now() - launchStart}ms`);

    b.on('disconnected', () => {
      log('browser disconnected unexpectedly');
      browser = null;
      context = null;
      contextPromise = null;
    });

    browser = b;
    return b;
  })();

  try {
    const b = await browserPromise;
    resetIdleTimer();
    return b;
  } finally {
    browserPromise = null;
  }
}

export async function getContext(): Promise<BrowserContext> {
  if (context) {
    log('reusing existing browser context');
    resetIdleTimer();
    return context;
  }

  // BUG-001: Use a mutex promise to prevent concurrent context creation
  if (contextPromise) {
    log('waiting for in-flight context creation');
    return contextPromise;
  }

  contextPromise = (async () => {
    const b = await getBrowser();

    // Load auth config once
    if (!authConfig) {
      authConfig = await loadAuth();
    }

    log('creating new browser context');
    const ctx = await b.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    });

    // Inject stability detection on every page
    await ctx.addInitScript(STABILITY_SCRIPT);

    // Inject auth cookies if configured
    if (authConfig?.cookies?.length) {
      log(`injecting ${authConfig.cookies.length} auth cookies`);
      await ctx.addCookies(authConfig.cookies);
    }

    context = ctx;
    return ctx;
  })();

  try {
    return await contextPromise;
  } finally {
    contextPromise = null;
  }
}

export async function getPage(url: string, viewport?: { width: number; height: number }): Promise<Page> {
  // BUG-002: Validate URL before doing anything
  validateUrl(url);

  const ctx = await getContext();

  log(`creating new page for ${url}`);
  const page = await ctx.newPage();

  // BUG-004: Track active pages
  activePageCount++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  page.on('crash', () => log(`page CRASHED: ${url}`));
  page.on('close', () => {
    log(`page closed: ${url}`);
    activePageCount--;
    // BUG-004: Reset idle timer when last page closes
    if (activePageCount <= 0) {
      activePageCount = 0;
      resetIdleTimer();
    }
  });
  page.on('pageerror', (err) => log(`page JS error: ${err.message}`));

  // Block heavy media that slows page load but doesn't affect screenshots
  await page.route(/\.(mp4|webm|ogg|mp3|wav|flac|avi)(\?.*)?$/i, (route) => route.abort());

  if (viewport) {
    log(`setting viewport to ${viewport.width}x${viewport.height}`);
    await page.setViewportSize(viewport);
  }

  // BUG-008/009: Inject localStorage via addInitScript instead of navigating to origin
  if (authConfig?.localStorage) {
    try {
      const origin = new URL(url).origin;
      const items = authConfig.localStorage[origin];
      if (items) {
        log(`injecting localStorage for ${origin} via initScript`);
        await page.addInitScript((storageItems: Record<string, string>) => {
          for (const [k, v] of Object.entries(storageItems)) {
            try {
              localStorage.setItem(k, v);
            } catch {
              /* ignore */
            }
          }
        }, items);
      }
    } catch {
      // Invalid URL — skip localStorage injection, validateUrl already caught bad URLs
    }
  }

  return page;
}

export async function shutdown(): Promise<void> {
  log('shutdown called');
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (context) {
    log('closing browser context');
    await context
      .close()
      .catch((err) => log(`context close error: ${err instanceof Error ? err.message : String(err)}`));
    context = null;
  }
  if (browser) {
    log('closing browser');
    await browser
      .close()
      .catch((err) => log(`browser close error: ${err instanceof Error ? err.message : String(err)}`));
    browser = null;
  }
  browserPromise = null;
  contextPromise = null;
  log('shutdown complete');
}
