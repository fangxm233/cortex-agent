// input:  MCP SDK and answer_subtask registrar
// output: cortex-manager-qa MCP stdio service
// pos:    Shared manager-answer MCP server
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerAnswerSubtaskTool } from './tools/manager-qa.js';

const log = createLogger('mcp-manager-qa');
const server = new McpServer({ name: 'cortex-manager-qa', version: CORTEX_VERSION });

registerAnswerSubtaskTool(server);

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
