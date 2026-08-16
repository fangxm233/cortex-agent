// input:  MCP SDK, tool gate, thread-control and ask_manager registrars
// output: cortex-thread MCP stdio service
// pos:    Thread lifecycle and upward-question MCP server
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { registerAskManagerTool } from './tools/manager-qa.js';
import { registerThreadTools } from './tools/thread-ops.js';

const log = createLogger('mcp-thread');
const server = new McpServer({ name: 'cortex-thread', version: CORTEX_VERSION });

registerGatedMcpTools(server, (target) => {
  registerThreadTools(target);
  registerAskManagerTool(target);
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
