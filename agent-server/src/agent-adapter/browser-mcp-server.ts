// input:  a CDP endpoint of a managed browser
// output: the one MCP server descriptor that exposes it, in the shape every backend accepts
// pos:    Shared by the Claude and PI spawn paths; the single definition of "the browser tools"
// >>> If I am updated, update CORTEX.md <<<

import * as path from 'path';
import { DATA_DIR } from '@core/paths.js';
import type { McpStdioServerConfig } from './types.js';

/** Pinned: an unpinned `npx @playwright/mcp` would silently change the agent's tool surface — and
 *  its snapshot format — on any upstream release. */
const PLAYWRIGHT_MCP_SPEC = '@playwright/mcp@0.0.79';

/** Playwright writes snapshots/screenshots relative to its cwd; give it a Cortex-owned directory so
 *  it never litters a repository the agent happens to be working in. */
export const BROWSER_MCP_OUTPUT_DIR = path.join(DATA_DIR, 'browser', 'mcp-output');

/** The server name every backend sees. PI prefixes its plugin tools with it, so it is user-visible
 *  there (`plugin_server_playwright_browser_navigate`). */
export const BROWSER_MCP_SERVER_NAME = 'playwright';

/**
 * One definition, three backends. Claude wraps it in a `--mcp-config` file, the Claude TUI adapter
 * passes the same file, and PI writes it into its plugin-MCP envelope for the bridge to connect to.
 * Keeping the descriptor here is what stops the pinned version and the output directory from
 * drifting apart between them.
 */
export function browserMcpServer(cdpEndpoint: string): McpStdioServerConfig {
  return {
    name: BROWSER_MCP_SERVER_NAME,
    type: 'stdio',
    command: 'npx',
    // `--cdp-endpoint` attaches to the ALREADY-RUNNING managed Chrome rather than launching a
    // private one — that is what lets the agent use the profile the human logged in with.
    args: ['-y', PLAYWRIGHT_MCP_SPEC, '--cdp-endpoint', cdpEndpoint, '--output-dir', BROWSER_MCP_OUTPUT_DIR],
    env: {},
    cwd: BROWSER_MCP_OUTPUT_DIR,
  };
}
