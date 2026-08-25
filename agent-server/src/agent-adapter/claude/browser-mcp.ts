// input:  a CDP endpoint of the managed browser
// output: a private --mcp-config file exposing Playwright MCP against that browser
// pos:    Claude spawn path; only reached by sessions that opted into browser control
// >>> If I am updated, update CORTEX.md <<<

import * as path from 'path';
import { DATA_DIR } from '@core/paths.js';
import { writeClaudeSupplementalMcpConfig } from './mcp-config.js';

/** Pinned: an unpinned `npx @playwright/mcp` would silently change the agent's tool surface — and
 *  its snapshot format — on any upstream release. */
const PLAYWRIGHT_MCP_SPEC = '@playwright/mcp@0.0.79';

/** Playwright writes snapshots/screenshots relative to its cwd; give it a Cortex-owned directory so
 *  it never litters a repository the agent happens to be working in. */
const OUTPUT_DIR = path.join(DATA_DIR, 'browser', 'mcp-output');

/**
 * A one-server MCP config bound to `cdpEndpoint`. Written as a content-hashed private file, so two
 * sessions pointed at the same browser share one file and a changed endpoint yields a new path
 * (which is what makes it usable as a session-pool compatibility key).
 */
export function writeBrowserMcpConfig(cdpEndpoint: string): { path: string; identity: string } {
  return writeClaudeSupplementalMcpConfig([
    {
      name: 'playwright',
      type: 'stdio',
      command: 'npx',
      // `--cdp-endpoint` attaches to the ALREADY-RUNNING managed Chrome rather than launching a
      // private one — that is what lets the agent use the profile the human logged in with.
      args: ['-y', PLAYWRIGHT_MCP_SPEC, '--cdp-endpoint', cdpEndpoint, '--output-dir', OUTPUT_DIR],
      env: {},
      cwd: OUTPUT_DIR,
    },
  ]);
}
