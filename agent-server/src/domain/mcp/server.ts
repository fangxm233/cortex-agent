// input:  MCP SDK, tool gate, cost/execution/context/schedule registrars
// output: platform-agnostic ext MCP stdio service assembled from production registrations
// pos:    ext server; no remote/platform tools and no duplicate name inventory
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCostTools } from './tools/cost.js';
import { registerExecutionTools } from './tools/executions.js';
import { registerContextTools } from './tools/context.js';
import { registerScheduleTools } from './tools/schedule.js';
import { executionRepo } from '@store/execution-repo.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';

const log = createLogger('mcp-server');

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-ext', version: CORTEX_VERSION });

registerGatedMcpTools(server, (target) => {
  registerCostTools(target);
  registerExecutionTools(target);
  registerContextTools(target);
  registerScheduleTools(target);
});

// --- Start (called by barrel when run as standalone) ---

export async function startServer(): Promise<void> {
  executionRepo.load();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  startServer().catch((e) => {
    log.error(e);
    process.exit(1);
  });
}
