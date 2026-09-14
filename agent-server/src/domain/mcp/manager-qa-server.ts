import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { registerAnswerSubtaskTool } from './tools/manager-qa.js';
import { toolContextFromEnv } from './tools/context.js';

const log = createLogger('mcp-manager-qa');
const ctx = toolContextFromEnv();
const server = new McpServer({ name: 'cortex-manager-qa', version: CORTEX_VERSION });

registerGatedMcpTools(server, target => registerAnswerSubtaskTool(target, ctx), ctx.toolAllowlist);

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
