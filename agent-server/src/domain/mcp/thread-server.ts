import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { registerAskManagerTool } from './tools/manager-qa.js';
import { registerThreadTools } from './tools/thread-ops.js';
import { toolContextFromEnv } from './tools/context.js';

const log = createLogger('mcp-thread');
const ctx = toolContextFromEnv();
const server = new McpServer({ name: 'cortex-thread', version: CORTEX_VERSION });

registerGatedMcpTools(server, (target) => {
  registerThreadTools(target, ctx);
  registerAskManagerTool(target, ctx);
}, ctx.toolAllowlist);

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
