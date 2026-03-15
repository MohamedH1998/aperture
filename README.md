# Aperture

Token-budget-aware visual feedback loop for AI coding agents.

Aperture is an MCP server that gives coding agents **eyes**. It screenshots your local dev server, resizes the image to fit a token budget you control, detects visual changes, computes diffs, and handles multi-step browser interactions — all through 6 MCP tools that any MCP-compatible agent (Claude Code, OpenCode, etc.) can call.

## The Problem

AI coding agents building UI are blind. They read and write code but never see the rendered output. The human becomes the agent's eyes — manually screenshotting, describing what's wrong, feeding back visual context. This bottleneck defeats the purpose of agentic automation.

Aperture closes the loop: **see current UI → make changes → see result → self-correct**.

## Why Token Budget Matters

Every screenshot costs tokens. A naive 1280x720 PNG burns ~1,229 tokens per capture. Over a 10-iteration session, that's 12,000+ tokens on screenshots alone — competing with code context for the agent's limited context window.

Aperture makes token cost a first-class parameter. The agent says `token_budget: 300` and gets a 640x360 JPEG that costs exactly ~300 tokens. The agent controls the tradeoff between visual fidelity and cost on every call.

**Image format (JPEG/PNG/WebP) has zero effect on Claude's token count** — only pixel dimensions matter. Aperture uses JPEG q80 purely for fast encoding and small transfer size.

| Budget | Resolution | Tokens | Use Case |
|--------|-----------|--------|----------|
| 100 | 384x216 | ~111 | Quick layout check |
| **300** | **640x360** | **~307** | **Default — most checks** |
| 500 | 940x528 | ~658 | Spacing/alignment detail |
| 800 | 1180x664 | ~796 | Typography, color accuracy |
| 1200 | 1452x816 | ~1,581 | Maximum detail |

## Quick Start

### Prerequisites

- Node.js >= 20
- Playwright Chromium browser installed:
  ```bash
  npx playwright-core install chromium
  ```

### Add to Claude Code

```json
{
  "mcpServers": {
    "aperture": {
      "command": "npx",
      "args": ["-y", "aperture-mcp"]
    }
  }
}
```

### Add to OpenCode

```json
{
  "mcp": {
    "aperture": {
      "type": "local",
      "command": ["npx", "-y", "aperture-mcp"],
      "enabled": true
    }
  }
}
```

### Install Claude Code Hook (Optional)

Auto-install a PostToolUse hook that nudges the agent to check its visual work after editing UI files:

```bash
npx aperture-mcp --install-hook
```

That's it. The agent now has 6 visual tools available.

## Tools

### `screenshot`

Capture a URL. Returns a JPEG image resized to your token budget.

```
screenshot({
  url: "http://localhost:4321",          // Required
  token_budget: 300,                     // Optional. Default 300.
  wait: "auto",                          // Optional. "auto" | "none" | milliseconds
  viewport_width: 1280,                  // Optional. Default 1280.
  viewport_height: 720,                  // Optional. Default 720.
  full_page: false                       // Optional. Default false.
})
```

**Returns:** JPEG image + metadata (dimensions, estimated tokens, timestamp).

**Wait strategies:**
- `"auto"` (default) — Composite stability detection. Waits for DOM mutations to quiet, fonts to load, CSS animations to finish, and layout shifts to settle. 1.5-second hard timeout.
- `"none"` — Instant capture. Use when you know the page is already loaded.
- `1000` — Fixed delay in milliseconds. Fallback when auto-detection isn't appropriate.

---

### `screenshot_element`

Capture a specific element by CSS selector. More token-efficient than full-page captures — screenshot just the component you're working on.

```
screenshot_element({
  url: "http://localhost:4321/pricing",
  selector: ".pricing-card",            // Any valid CSS selector
  token_budget: 200,
  wait: "auto"
})
```

**Returns:** JPEG image of the element + metadata.

---

### `screenshot_diff`

Capture a screenshot and compare it against the previous capture of the same URL. First call establishes a baseline. Subsequent calls return the current screenshot plus a diff overlay showing changed pixels.

```
screenshot_diff({
  url: "http://localhost:4321/pricing",
  token_budget: 300,
  wait: "auto"
})
```

**Returns:**
- First call: Current screenshot + "This is now the baseline" message.
- Subsequent calls: Current screenshot + diff overlay image + `{ changePercent, pixelsChanged, totalPixels }`.

---

### `has_changed`

Check if a page has visually changed since the last check. Returns a boolean — **costs zero image tokens**. Call this before `screenshot` to avoid wasting tokens on unchanged pages.

```
has_changed({
  url: "http://localhost:4321"
})
```

**Returns:** `{ changed: true/false, url, checkedAt }` as text. No image.

Internally captures a tiny 160x90 JPEG and compares its hash against the previous capture. The tiny image is never sent to the agent.

---

### `smart_check`

Check if a page changed AND capture a screenshot in one call. If unchanged, returns immediately at zero image token cost. If changed, captures at your budget.

```
smart_check({
  url: "http://localhost:4321",
  token_budget: 300,                     // Optional. Default 300.
  wait: "auto"                           // Optional. Default "auto".
})
```

**Returns:**
- If unchanged: `{ changed: false }` — **zero image tokens**.
- If changed: JPEG screenshot + metadata — same as `screenshot`.

This collapses the common `has_changed` → `screenshot` two-step pattern into a single round-trip, saving an LLM inference cycle.

---

### `interact_and_screenshot`

Execute a sequence of browser actions, then capture a screenshot. Use this to reach authenticated pages, specific UI states, or pages that require navigation.

```
interact_and_screenshot({
  url: "http://localhost:4321/login",
  actions: [
    { type: "fill", selector: "#email", value: "dev@test.com" },
    { type: "fill", selector: "#password", value: "password" },
    { type: "click", selector: "#submit" },
    { type: "wait", ms: 500 }
  ],
  token_budget: 300
})
```

**Supported actions:**
| Action | Parameters | Description |
|--------|-----------|-------------|
| `click` | `selector` | Click an element |
| `fill` | `selector`, `value` | Fill an input field |
| `wait` | `ms` | Wait for milliseconds |
| `navigate` | `url` | Navigate to a URL |

**Returns:** JPEG image of the final state + metadata.

## Typical Agent Workflow

```
You: "The spacing on the pricing cards looks cramped, fix it"

Agent: screenshot({ url: "http://localhost:4321/pricing", token_budget: 300 })
       → Sees the current layout (~300 tokens)

Agent: screenshot_element({ url: "...", selector: ".pricing-card", token_budget: 200 })
       → Zooms in on just the card (~200 tokens)

Agent: "Cards have tight spacing. Increasing padding and gap."
       → Edits src/components/PricingCard.astro

Agent: has_changed({ url: "http://localhost:4321/pricing" })
       → { changed: true } (0 tokens)

Agent: screenshot_diff({ url: "http://localhost:4321/pricing", token_budget: 300 })
       → Sees updated layout + diff overlay showing what changed (~600 tokens)

Agent: "Spacing improved. Total visual cost: ~1,400 tokens for 4 captures."
```

## Stability Detection

Aperture injects a composite stability detection script into every page via Playwright's `addInitScript`. The script uses 4 independent Web Platform APIs to determine when a page has visually settled after a change:

| Signal | API | What It Detects |
|--------|-----|----------------|
| DOM mutations | `MutationObserver` | HMR updates, React re-renders, Astro island hydration |
| Font loading | `document.fonts.ready` | Web font swap completing |
| CSS animations | `document.getAnimations()` | Transitions and animations finishing (infinite loops excluded) |
| Layout shifts | `PerformanceObserver('layout-shift')` | Elements moving after load |

All 4 signals must go quiet for 150ms, OR a 1.5-second hard timeout fires. This is framework-agnostic — no Vite/Next.js/Astro-specific code.

**Limitations:**
- `MutationObserver` does not fire for CSS-in-JS `insertRule()` changes or CSS custom property updates via stylesheets.
- The stability detection is heuristic-based. For pages with persistent animations (loading spinners, blinking cursors), the hard timeout ensures the agent isn't blocked forever.
- If auto-detection doesn't suit your page, use `wait: "none"` or `wait: 1000` (fixed delay).

## Auth Configuration

For pages behind authentication, create `.aperture/auth.json` in your project root:

```json
{
  "cookies": [
    {
      "name": "session-token",
      "value": "your-dev-session-token",
      "domain": "localhost",
      "path": "/"
    }
  ],
  "localStorage": {
    "http://localhost:4321": {
      "auth_token": "your-dev-jwt"
    }
  }
}
```

Both `cookies` and `localStorage` are optional. Add `.aperture/` to your `.gitignore`.

**Cookie format** follows [Playwright's cookie spec](https://playwright.dev/docs/api/class-browsercontext#browser-context-add-cookies):
- `name` (required), `value` (required)
- `domain`, `path`, `expires`, `httpOnly`, `secure`, `sameSite` (all optional)

Cookies and localStorage are injected when the browser context is created. For dev environments with static tokens, set it once and forget it.

For dynamic auth flows (login forms, OAuth), use `interact_and_screenshot` instead.

## Architecture

```
aperture/
├── src/
│   ├── index.ts        Entry point: MCP server + stdio transport
│   ├── server.ts       5 tool definitions + handlers
│   ├── browser.ts      Playwright browser pool (lazy launch, warm context, 5min idle shutdown)
│   ├── capture.ts      Screenshot pipeline: goto → stability wait → capture → resize → encode
│   ├── budget.ts       Token budget → pixel dimensions calculator
│   ├── stability.ts    Composite stability detection script (injected into pages)
│   ├── diff.ts         pixelmatch visual diff engine + hash-based change detection
│   └── auth.ts         Cookie/localStorage config loader
└── build/              Compiled JS (tsc output)
```

**Key design decisions:**

- **Playwright-core** (not full Playwright) — lighter package, you install the browser separately.
- **Sharp** for image processing — resize to exact token-budget dimensions, JPEG q80.
- **pixelmatch** for visual diffing — perceptual comparison with configurable threshold.
- **Lazy browser pool** — Chromium launches on first tool call, stays warm across calls, auto-shuts down after 5 minutes of inactivity.
- **stdio transport** — standard MCP protocol. No HTTP server, no ports, no configuration beyond `.mcp.json`.
- **All logging to stderr** — stdout is reserved for JSON-RPC messages. `console.error` only.

## Performance

Benchmarked against `example.com` (representative of a simple dev server page):

| Scenario | Latency | Notes |
|----------|---------|-------|
| Cold start (first screenshot ever) | ~900ms | Includes Chromium launch |
| Warm screenshot (300 tokens) | **59ms** | Browser already running |
| Thumbnail (100 tokens) | 53ms | Cheapest visual check |
| High-res (800 tokens) | 71ms | Detailed inspection |
| `has_changed()` | ~60ms | Zero image tokens |

All warm calls are well under the 2-second target. Cold start is a one-time cost per session.

## Limitations & Known Issues

- **Headless Chromium, not your browser.** Font rendering may differ slightly from your local Chrome. Web fonts served by the dev server will match; system fonts may not.
- **No push-based automation.** The agent must explicitly call tools. There's no automatic "screenshot after every file edit" yet. You can approximate this with Claude Code hooks (see below).
- **Auth config is manual.** You need to extract cookies/tokens and put them in `.aperture/auth.json`. For short-lived JWTs, this requires periodic refresh.
- **Stability detection is heuristic.** Pages with CSS-in-JS `insertRule()` changes may not trigger `MutationObserver`. The hard timeout covers this but may capture a mid-transition state.
- **Single browser context.** All screenshots share one browser context. If one tool call navigates to a page that sets cookies, subsequent calls see those cookies.

## Tips

- **Start with `has_changed`** after editing code. It costs 0 image tokens and tells you if a screenshot is worth taking.
- **Use `screenshot_element`** instead of full-page captures when working on a specific component. It's 60-80% cheaper in tokens.
- **Use `token_budget: 100`** for quick "did anything change?" checks. `token_budget: 800` for "is this pixel-perfect?".
- **Use `wait: "none"`** if your dev server has fast HMR and you're calling the tool a second or two after editing. The stability detection's 150ms quiet period adds latency you may not need.
- **Use `screenshot_diff`** for iterative refinement. The diff overlay makes it immediately obvious what changed between edits.

## Claude Code Hook (Optional)

To nudge the agent to use its eyes after editing visual files, add a PostToolUse hook to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "if echo \"$TOOL_INPUT\" | grep -qE '\\.(css|scss|tsx|jsx|astro|svelte|vue|html)'; then echo 'Visual file changed — consider calling has_changed() or screenshot()' >&2; fi"
          }
        ]
      }
    ]
  }
}
```

This prints a hint to stderr (which the agent sees) after edits to visual files. It costs nothing and reminds the agent to check its work.

## License

MIT
