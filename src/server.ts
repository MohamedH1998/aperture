/**
 * MCP tool definitions and handlers for Aperture.
 *
 * 6 tools:
 * 1. screenshot          — capture a URL at token budget
 * 2. screenshot_element   — capture a CSS-selected element
 * 3. screenshot_diff      — visual diff against previous capture
 * 4. has_changed          — zero-token change detection
 * 5. interact_and_screenshot — multi-step navigation then capture
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { captureScreenshot, captureTiny, type WaitStrategy } from './capture.js';
import { computeDiff, detectChange } from './diff.js';
import { dimensionsFromBudget, DEFAULT_BUDGET } from './budget.js';
import { getPage } from './browser.js';
import sharp from 'sharp';
import { log } from './log.js';

type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };
type Content = TextContent | ImageContent;
type ToolResult = { content: Content[]; isError?: boolean };

function textContent(text: string): TextContent {
  return { type: 'text', text };
}

function imageContent(base64: string, mimeType = 'image/jpeg'): ImageContent {
  return { type: 'image', data: base64, mimeType };
}

function errorResult(msg: string): ToolResult {
  return { isError: true, content: [textContent(msg)] };
}

export function registerTools(server: McpServer): void {
  // ── screenshot ──────────────────────────────────────────────────────────────
  server.tool(
    'screenshot',
    'Capture a screenshot of a URL. Returns a JPEG image resized to fit your token budget. Default budget is 300 tokens (~640x360). Use token_budget to control cost.',
    {
      url: z.string().describe('Full URL to screenshot (e.g. http://localhost:4321)'),
      token_budget: z
        .number()
        .optional()
        .describe('Max tokens to spend on this image. Default 300. Use 100 for thumbnails, 800+ for detail.'),
      wait: z
        .union([z.literal('auto'), z.literal('none'), z.number()])
        .optional()
        .describe(
          'Wait strategy: "auto" (composite stability detection, default), "none" (instant), or milliseconds (fixed delay)',
        ),
      viewport_width: z.number().min(1).max(4096).optional().describe('Viewport width in CSS pixels. Default 1280.'),
      viewport_height: z.number().min(1).max(4096).optional().describe('Viewport height in CSS pixels. Default 720.'),
      full_page: z.boolean().optional().describe('Capture full scrollable page, not just viewport. Default false.'),
    },
    async (params): Promise<ToolResult> => {
      const toolStart = Date.now();
      log(
        `tool:screenshot called url=${params.url} budget=${params.token_budget} wait=${params.wait} viewport=${params.viewport_width}x${params.viewport_height} fullPage=${params.full_page}`,
      );
      try {
        const viewport =
          params.viewport_width || params.viewport_height
            ? { width: params.viewport_width ?? 1280, height: params.viewport_height ?? 720 }
            : undefined;

        const result = await captureScreenshot({
          url: params.url,
          tokenBudget: params.token_budget ?? DEFAULT_BUDGET,
          wait: (params.wait as WaitStrategy) ?? 'auto',
          viewport,
          fullPage: params.full_page,
        });

        log(`tool:screenshot completed in ${Date.now() - toolStart}ms`);
        return {
          content: [
            imageContent(result.base64),
            textContent(
              JSON.stringify({
                url: result.url,
                dimensions: result.dimensions,
                estimatedTokens: result.estimatedTokens,
                capturedAt: result.capturedAt,
              }),
            ),
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        log(`tool:screenshot FAILED after ${Date.now() - toolStart}ms: ${msg}`);
        if (stack) log(`tool:screenshot stack: ${stack}`);
        return errorResult(`Screenshot failed: ${msg}`);
      }
    },
  );

  // ── screenshot_element ──────────────────────────────────────────────────────
  server.tool(
    'screenshot_element',
    'Capture a specific element by CSS selector. More token-efficient than full-page screenshots — captures only the component you care about.',
    {
      url: z.string().describe('Full URL containing the element'),
      selector: z
        .string()
        .describe('CSS selector for the element (e.g. ".pricing-card", "#hero", "[data-testid=header]")'),
      token_budget: z.number().optional().describe('Max tokens. Default 300.'),
      wait: z
        .union([z.literal('auto'), z.literal('none'), z.number()])
        .optional()
        .describe('Wait strategy. Default "auto".'),
    },
    async (params): Promise<ToolResult> => {
      try {
        const result = await captureScreenshot({
          url: params.url,
          selector: params.selector,
          tokenBudget: params.token_budget ?? DEFAULT_BUDGET,
          wait: (params.wait as WaitStrategy) ?? 'auto',
        });

        return {
          content: [
            imageContent(result.base64),
            textContent(
              JSON.stringify({
                url: result.url,
                selector: params.selector,
                dimensions: result.dimensions,
                estimatedTokens: result.estimatedTokens,
                capturedAt: result.capturedAt,
              }),
            ),
          ],
        };
      } catch (err) {
        return errorResult(`Element screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── screenshot_diff ─────────────────────────────────────────────────────────
  server.tool(
    'screenshot_diff',
    'Capture a screenshot and compare it to the previous capture of the same URL. Returns the current screenshot plus a diff overlay showing changed pixels in red. First call establishes baseline.',
    {
      url: z.string().describe('Full URL to diff'),
      token_budget: z.number().optional().describe('Max tokens per image. Default 300.'),
      wait: z
        .union([z.literal('auto'), z.literal('none'), z.number()])
        .optional()
        .describe('Wait strategy. Default "auto".'),
    },
    async (params): Promise<ToolResult> => {
      try {
        const result = await captureScreenshot({
          url: params.url,
          tokenBudget: params.token_budget ?? DEFAULT_BUDGET,
          wait: (params.wait as WaitStrategy) ?? 'auto',
        });

        const diff = await computeDiff(result.image, params.url);

        const content: Content[] = [imageContent(result.base64)];

        if (diff.hasPrevious) {
          content.push(
            imageContent(diff.diffBase64),
            textContent(
              JSON.stringify({
                changePercent: diff.changePercent,
                pixelsChanged: diff.pixelsChanged,
                totalPixels: diff.totalPixels,
                dimensions: result.dimensions,
                estimatedTokens: result.estimatedTokens,
              }),
            ),
          );
        } else {
          content.push(
            textContent('First capture — no previous screenshot to diff against. This is now the baseline.'),
          );
        }

        return { content };
      } catch (err) {
        return errorResult(`Diff failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── has_changed ─────────────────────────────────────────────────────────────
  server.tool(
    'has_changed',
    'Check if a page has visually changed since the last check. Returns a boolean — costs ZERO image tokens. Call this before screenshot to avoid wasting tokens on unchanged pages.',
    {
      url: z.string().describe('Full URL to check'),
    },
    async (params): Promise<ToolResult> => {
      try {
        const tiny = await captureTiny(params.url);
        const changed = detectChange(tiny, params.url);

        return {
          content: [
            textContent(
              JSON.stringify({
                changed,
                url: params.url,
                checkedAt: new Date().toISOString(),
              }),
            ),
          ],
        };
      } catch (err) {
        return errorResult(`Change check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── smart_check ────────────────────────────────────────────────────────────
  server.tool(
    'smart_check',
    'Check if a page changed AND capture a screenshot in one call. If unchanged, returns immediately at ZERO image token cost. If changed, captures at your budget. Saves a round-trip vs calling has_changed then screenshot separately.',
    {
      url: z.string().describe('Full URL to check'),
      token_budget: z.number().optional().describe('Max tokens if screenshot is needed. Default 300.'),
      wait: z
        .union([z.literal('auto'), z.literal('none'), z.number()])
        .optional()
        .describe('Wait strategy. Default "auto".'),
    },
    async (params): Promise<ToolResult> => {
      const toolStart = Date.now();
      log(`tool:smart_check called url=${params.url} budget=${params.token_budget}`);
      try {
        // Step 1: cheap hash-based change detection
        const tiny = await captureTiny(params.url);
        const changed = detectChange(tiny, params.url);

        if (!changed) {
          log(`tool:smart_check no change detected in ${Date.now() - toolStart}ms`);
          return {
            content: [
              textContent(
                JSON.stringify({
                  changed: false,
                  url: params.url,
                  checkedAt: new Date().toISOString(),
                }),
              ),
            ],
          };
        }

        // Step 2: page changed — capture at full budget
        log('tool:smart_check change detected, capturing screenshot');
        const result = await captureScreenshot({
          url: params.url,
          tokenBudget: params.token_budget ?? DEFAULT_BUDGET,
          wait: (params.wait as WaitStrategy) ?? 'auto',
        });

        log(`tool:smart_check completed in ${Date.now() - toolStart}ms`);
        return {
          content: [
            imageContent(result.base64),
            textContent(
              JSON.stringify({
                changed: true,
                url: result.url,
                dimensions: result.dimensions,
                estimatedTokens: result.estimatedTokens,
                capturedAt: result.capturedAt,
              }),
            ),
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`tool:smart_check FAILED after ${Date.now() - toolStart}ms: ${msg}`);
        return errorResult(`Smart check failed: ${msg}`);
      }
    },
  );

  // ── interact_and_screenshot ─────────────────────────────────────────────────
  const actionSchema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('click'),
      selector: z.string(),
      force: z
        .boolean()
        .optional()
        .describe('Skip visibility/interactability checks. Use when the element exists but is off-screen or obscured.'),
    }),
    z.object({ type: z.literal('fill'), selector: z.string(), value: z.string() }),
    z.object({ type: z.literal('hover'), selector: z.string() }),
    z.object({
      type: z.literal('scroll'),
      x: z.number().optional().describe('Horizontal scroll delta in pixels. Default 0.'),
      y: z.number().optional().describe('Vertical scroll delta in pixels. Default 0.'),
      selector: z.string().optional().describe('CSS selector to scroll into view. If provided, x/y are ignored.'),
    }),
    z.object({
      type: z.literal('select_option'),
      selector: z.string(),
      value: z.string().describe('Option value to select'),
    }),
    z.object({ type: z.literal('wait'), ms: z.number().max(30_000) }),
    z.object({ type: z.literal('navigate'), url: z.string() }),
  ]);

  server.tool(
    'interact_and_screenshot',
    'Execute a sequence of browser actions (click, fill, hover, scroll, select_option, wait, navigate) then capture a screenshot. click supports force:true to bypass visibility checks. scroll accepts x/y deltas or a selector to scroll into view.',
    {
      url: z.string().describe('Starting URL'),
      actions: z.array(actionSchema).max(50).describe('Actions to perform before capturing'),
      token_budget: z.number().optional().describe('Max tokens. Default 300.'),
    },
    async (params): Promise<ToolResult> => {
      const page = await getPage(params.url);

      try {
        await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });

        for (const action of params.actions) {
          switch (action.type) {
            case 'click':
              await page.locator(action.selector).click({ timeout: 5_000, force: action.force ?? false });
              break;
            case 'fill':
              await page.locator(action.selector).fill(action.value);
              break;
            case 'hover':
              await page.locator(action.selector).hover({ timeout: 5_000 });
              break;
            case 'scroll':
              if (action.selector) {
                await page.locator(action.selector).scrollIntoViewIfNeeded({ timeout: 5_000 });
              } else {
                await page.mouse.wheel(action.x ?? 0, action.y ?? 0);
              }
              break;
            case 'select_option':
              await page.locator(action.selector).selectOption(action.value, { timeout: 5_000 });
              break;
            case 'wait':
              await page.waitForTimeout(action.ms);
              break;
            case 'navigate':
              await page.goto(action.url, { waitUntil: 'load', timeout: 15_000 });
              break;
          }
        }

        // Wait for stability after actions (with ceiling to prevent hanging)
        try {
          const evalPromise = page.evaluate(
            () => (window as unknown as { __apertureStable: unknown }).__apertureStable,
          );
          const ceiling = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
          await Promise.race([evalPromise, ceiling]);
          evalPromise.catch(() => {});
        } catch {
          if (!page.isClosed()) {
            await page.waitForTimeout(500).catch(() => {});
          }
        }

        const budget = params.token_budget ?? DEFAULT_BUDGET;
        const dims = dimensionsFromBudget(budget);

        const raw = await page.screenshot({ type: 'png' });
        const resized = await sharp(raw)
          .resize(dims.width, dims.height, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer({ resolveWithObject: true });

        const base64 = resized.data.toString('base64');
        const estimatedTokens = Math.ceil((resized.info.width * resized.info.height) / 750);

        return {
          content: [
            imageContent(base64),
            textContent(
              JSON.stringify({
                url: page.url(),
                actionsExecuted: params.actions.length,
                dimensions: { width: resized.info.width, height: resized.info.height },
                estimatedTokens,
              }),
            ),
          ],
        };
      } catch (err) {
        return errorResult(`Interaction failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await page.close();
      }
    },
  );
}
