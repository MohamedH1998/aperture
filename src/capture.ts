/**
 * Screenshot capture pipeline.
 *
 * url → page.goto → stability wait → page.screenshot → sharp resize → JPEG encode → base64
 *
 * The pipeline is designed to be token-efficient:
 * - Agent specifies a token_budget, not a resolution
 * - Server computes optimal dimensions from budget
 * - Image is resized BEFORE encoding to minimize transfer size
 * - JPEG q80 is the default (format doesn't affect Claude's token count, only dimensions do)
 */

import sharp from 'sharp';
import type { Page } from 'playwright-core';
import { getOrCreatePage, keepPageWarm } from './browser.js';
import { dimensionsFromBudget, DEFAULT_BUDGET, type Dimensions } from './budget.js';
import { log } from './log.js';

export type WaitStrategy = 'auto' | 'none' | number;

export interface CaptureOptions {
  url: string;
  tokenBudget?: number;
  wait?: WaitStrategy;
  viewport?: { width: number; height: number };
  selector?: string;
  fullPage?: boolean;
}

export interface CaptureResult {
  image: Buffer;
  base64: string;
  dimensions: Dimensions;
  estimatedTokens: number;
  url: string;
  capturedAt: string;
}

async function waitForStability(page: Page, wait: WaitStrategy): Promise<void> {
  if (wait === 'none') {
    log('stability: skipped (wait=none)');
    return;
  }

  if (typeof wait === 'number') {
    log(`stability: fixed delay ${wait}ms`);
    await page.waitForTimeout(wait);
    log('stability: fixed delay complete');
    return;
  }

  // Auto: use composite stability detection with a hard ceiling.
  // page.evaluate awaits the browser-side Promise, but if the stability
  // script never resolves (e.g., HMR keeps mutating the DOM), this would
  // hang forever. Race against a plain setTimeout so we always proceed.
  log('stability: waiting for __apertureStable');
  const stabilityStart = Date.now();
  const STABILITY_CEILING_MS = 2_000;
  try {
    const evaluatePromise = page.evaluate(() => (window as unknown as { __apertureStable: unknown }).__apertureStable);
    // Plain setTimeout — doesn't depend on the page being alive
    const ceilingPromise = new Promise<void>((resolve) => setTimeout(resolve, STABILITY_CEILING_MS));

    await Promise.race([evaluatePromise, ceilingPromise]);
    // Prevent unhandled rejection from the losing promise
    evaluatePromise.catch(() => {});
    log(`stability: resolved in ${Date.now() - stabilityStart}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`stability: __apertureStable failed after ${Date.now() - stabilityStart}ms: ${msg}`);
    // Only attempt fallback delay if the page is still alive
    if (!page.isClosed()) {
      log('stability: falling back to 500ms delay');
      await page.waitForTimeout(500).catch(() => {});
      log('stability: fallback delay complete');
    } else {
      log('stability: page is closed, skipping fallback');
    }
  }
}

export async function captureScreenshot(opts: CaptureOptions): Promise<CaptureResult> {
  const budget = opts.tokenBudget ?? DEFAULT_BUDGET;
  const wait = opts.wait ?? 'auto';
  const dims = dimensionsFromBudget(budget);
  const pipelineStart = Date.now();

  log(
    `capture: url=${opts.url} budget=${budget} wait=${wait} dims=${dims.width}x${dims.height} fullPage=${opts.fullPage ?? false}`,
  );

  const { page, isWarm } = await getOrCreatePage(opts.url, opts.viewport);
  log(`capture: page ready (warm=${isWarm}) (+${Date.now() - pipelineStart}ms)`);

  try {
    if (isWarm) {
      // Warm page — skip navigation, just wait one frame for any in-flight HMR render
      if (wait !== 'none') {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
      log(`capture: warm page settled (+${Date.now() - pipelineStart}ms)`);
    } else {
      // Cold page — full navigation + stability
      log('capture: navigating (goto)');
      const gotoStart = Date.now();
      await page.goto(opts.url, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
      log(`capture: DOM ready (+${Date.now() - gotoStart}ms)`);
      await waitForStability(page, wait);
    }

    let rawBuffer: Buffer;

    if (opts.selector) {
      // Element screenshot — must use PNG for transparency
      log(`capture: waiting for selector "${opts.selector}"`);
      const locator = page.locator(opts.selector);
      await locator.waitFor({ state: 'visible', timeout: 5_000 });
      log('capture: taking element screenshot');
      rawBuffer = await locator.screenshot({ type: 'png' });
    } else {
      // Full viewport/page — take JPEG directly, skip PNG round-trip
      log('capture: taking screenshot (jpeg)');
      rawBuffer = await page.screenshot({
        type: 'jpeg',
        quality: 90,
        fullPage: opts.fullPage ?? false,
      });
    }
    log(`capture: raw screenshot ${rawBuffer.length} bytes (+${Date.now() - pipelineStart}ms)`);

    // Resize to token-budget dimensions + encode as JPEG q80
    log('capture: resizing with sharp');
    const resized = await sharp(rawBuffer)
      .resize(dims.width, dims.height, {
        fit: 'inside', // Maintain aspect ratio, fit within bounds
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });

    const base64 = resized.data.toString('base64');
    const estimatedTokens = Math.ceil((resized.info.width * resized.info.height) / 750);

    log(
      `capture: done in ${Date.now() - pipelineStart}ms, ${resized.info.width}x${resized.info.height}, ~${estimatedTokens} tokens, ${resized.data.length} bytes`,
    );

    // Keep page warm for next call
    keepPageWarm(opts.url, page);

    return {
      image: resized.data,
      base64,
      dimensions: { width: resized.info.width, height: resized.info.height },
      estimatedTokens,
      url: opts.url,
      capturedAt: new Date().toISOString(),
    };
  } catch (err) {
    // On error, close the page — don't keep broken pages warm
    await page.close().catch(() => {});
    throw err;
  }
}

/**
 * Lightweight capture for change detection only.
 * Tiny resolution, never sent to agent — just for hash comparison.
 */
export async function captureTiny(url: string, viewport?: { width: number; height: number }): Promise<Buffer> {
  log(`captureTiny: url=${url}`);
  const start = Date.now();
  const { page, isWarm } = await getOrCreatePage(url, viewport);

  try {
    if (isWarm) {
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      log(`captureTiny: DOM ready (+${Date.now() - start}ms)`);

      // Short stability wait — we just need it roughly settled
      try {
        const evalPromise = page.evaluate(() => (window as unknown as { __apertureStable: unknown }).__apertureStable);
        await Promise.race([evalPromise, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
        evalPromise.catch(() => {});
      } catch {
        if (!page.isClosed()) {
          await page.waitForTimeout(500).catch(() => {});
        }
      }
    }

    const raw = await page.screenshot({ type: 'jpeg', quality: 50 });
    log(`captureTiny: done in ${Date.now() - start}ms (warm=${isWarm})`);

    keepPageWarm(url, page);

    // Resize to tiny — just for comparison
    return sharp(raw).resize(160, 90, { fit: 'fill' }).jpeg({ quality: 50 }).toBuffer();
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}
