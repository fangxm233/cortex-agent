// input:  MCP SDK, tool gate, remote-operation and time registrars
// output: cortex-core MCP stdio service
// pos:    Remote execution and clock MCP server
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { registerTaskOpsTools } from './tools/task-ops.js';
import { registerTimeTools } from './tools/time.js';

const log = createLogger('mcp-core');
const server = new McpServer({ name: 'cortex-core', version: CORTEX_VERSION });

registerGatedMcpTools(server, (target) => {
  registerTaskOpsTools(target);
  registerTimeTools(target);
});

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  startServer().catch((error) => {
    log.error(error);
    process.exit(1);
  });
}
