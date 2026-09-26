import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFileTools } from './file.js';
import type { FeishuToolDeps } from './types.js';

export function registerFeishuTools(server: McpServer, deps: FeishuToolDeps): void {
  registerFileTools(server, deps);
}

export type { FeishuToolDeps } from './types.js';
