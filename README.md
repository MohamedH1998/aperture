# Aperture

MCP server that gives AI coding agents **eyes**. Screenshot your local dev server, control token cost, detect changes, compute visual diffs — all through MCP tools any compatible agent can call.

**The problem:** AI agents building UI are blind. They edit code but never see the result. You become their eyes — screenshotting, describing, feeding back. Aperture closes that loop automatically.

## Quick Start

```bash
npx playwright-core install chromium
```

Add to your MCP config:

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

Optionally install a Claude Code hook that nudges the agent to check its work after visual file edits:

```bash
npx aperture-mcp --install-hook
```

## Tools

| Tool | What it does | Token cost |
|------|-------------|------------|
| `screenshot` | Capture a URL at your token budget | Budget-controlled |
| `screenshot_element` | Capture a single element by CSS selector | Budget-controlled |
| `screenshot_diff` | Compare against previous capture, returns diff overlay | Budget-controlled |
| `has_changed` | Hash-based change detection | **Zero** |
| `smart_check` | `has_changed` + `screenshot` in one call — skips capture if unchanged | Zero or budget |
| `interact_and_screenshot` | Run browser actions (click, fill, scroll, hover, navigate, wait, select) then capture | Budget-controlled |

### Token Budgets

Every screenshot costs tokens. Aperture makes this a first-class parameter — you control the tradeoff per call.

| Budget | Resolution | Use case |
|--------|-----------|----------|
| 100 | 384x216 | Quick layout check |
| **300** | **640x360** | **Default** |
| 800 | 1180x664 | Typography, color accuracy |
| 1200 | 1452x816 | Maximum detail |

### Interaction Actions

`interact_and_screenshot` supports these action types:

| Action | Parameters | Notes |
|--------|-----------|-------|
| `click` | `selector`, `force?` | `force: true` bypasses visibility checks |
| `fill` | `selector`, `value` | Fill an input field |
| `scroll` | `selector?` or `x?`, `y?` | Scroll element into view, or scroll by pixel delta |
| `hover` | `selector` | Hover over an element |
| `select_option` | `selector`, `value` | Select a dropdown option |
| `wait` | `ms` | Wait up to 30s |
| `navigate` | `url` | Go to a URL |

## Auth

For pages behind auth, create `.aperture/auth.json`:

```json
{
  "cookies": [
    { "name": "session", "value": "your-token", "domain": "localhost", "path": "/" }
  ],
  "localStorage": {
    "http://localhost:4321": { "auth_token": "your-jwt" }
  }
}
```

Both fields optional. Add `.aperture/` to `.gitignore`.

## License

MIT
