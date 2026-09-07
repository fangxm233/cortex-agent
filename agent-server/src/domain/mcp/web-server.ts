// input:  MCP SDK, tool gate, Web UI file + view + decision registrars
// output: Web-specific MCP stdio service
// pos:    Serves file, view and decision delivery tools to Web-originated sessions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerUiFileTools } from './tools/ui-file.js';
import { registerUiViewTools } from './tools/ui-view.js';
import { registerUiDecisionTools } from './tools/ui-decision.js';
import { toolContextFromEnv } from './tools/context.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';

const log = createLogger('mcp-web');

// --- McpServer + tool registration ---

const ctx = toolContextFromEnv();
const server = new McpServer({ name: 'cortex-web', version: CORTEX_VERSION });

registerGatedMcpTools(server, (target) => {
  registerUiFileTools(target, ctx);
  registerUiViewTools(target, ctx);
  registerUiDecisionTools(target, ctx);
}, ctx.toolAllowlist);

// --- Start (called by barrel when run as standalone) ---

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  startServer().catch((e) => {
    log.error(e);
    process.exit(1);
  });
}
