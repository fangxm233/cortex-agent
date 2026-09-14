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
