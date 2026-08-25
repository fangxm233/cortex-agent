// input:  a CDP endpoint of the managed browser
// output: a private --mcp-config file exposing Playwright MCP against that browser
// pos:    Claude spawn path (print and TUI); only reached by sessions that opted into the browser
// >>> If I am updated, update CORTEX.md <<<

import { browserMcpServer } from '../browser-mcp-server.js';
import { writeClaudeSupplementalMcpConfig } from './mcp-config.js';

/**
 * A one-server MCP config bound to `cdpEndpoint`. Written as a content-hashed private file, so two
 * sessions pointed at the same browser share one file and a changed endpoint yields a new path
 * (which is what makes it usable as a session-pool compatibility key).
 */
export function writeBrowserMcpConfig(cdpEndpoint: string): { path: string; identity: string } {
  return writeClaudeSupplementalMcpConfig([browserMcpServer(cdpEndpoint)]);
}
