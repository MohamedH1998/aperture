#!/usr/bin/env node

/**
 * Aperture — Token-budget-aware visual feedback loop for AI coding agents.
 *
 * MCP server that gives agents eyes: screenshot URLs, diff changes,
 * detect visual updates, interact with pages — all with token cost
 * as a first-class parameter.
 *
 * Usage:
 *   npx aperture-mcp        # Start the MCP server (stdio transport)
 *
 * .mcp.json:
 *   {
 *     "mcpServers": {
 *       "aperture": {
 *         "command": "node",
 *         "args": ["/path/to/aperture/build/index.js"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './server.js';
import { shutdown } from './browser.js';
import { installHook } from './hook.js';

// CLI: npx aperture-mcp --install-hook
if (process.argv.includes('--install-hook')) {
  await installHook();
  process.exit(0);
}

const server = new McpServer({
  name: 'aperture',
  version: '0.1.0',
});

registerTools(server);

// Graceful shutdown
const cleanup = async () => {
  console.error('[aperture] Shutting down...');
  await shutdown();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
// BUG-024: Exit after uncaughtException — process state is unreliable
process.on('uncaughtException', (err) => {
  console.error('[aperture] Uncaught exception:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[aperture] Unhandled rejection:', err);
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);

console.error('[aperture] MCP server running on stdio');
console.error('[aperture] 6 tools available: screenshot, screenshot_element, screenshot_diff, has_changed, smart_check, interact_and_screenshot');
