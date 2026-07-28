// input:  MCP SDK, file-tool registrar, and Feishu dependencies
// output: registerFeishuTools wiring the production Feishu file tool
// pos:    single registration entry; no duplicate exported name inventory
//         Document/table/wiki tooling was removed in favor of the official lark-cli
//         (see the feishu-doc skill); this MCP now only exposes file sending.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFileTools } from './file.js';
import type { FeishuToolDeps } from './types.js';

export function registerFeishuTools(server: McpServer, deps: FeishuToolDeps): void {
  registerFileTools(server, deps);
}

export type { FeishuToolDeps } from './types.js';
