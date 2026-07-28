// input:  MCP SDK plus cost, execution, context, and schedule registrars
// output: platform-agnostic ext MCP stdio service assembled from production registrations
// pos:    ext server; no remote/platform tools and no duplicate name inventory
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCostTools } from './tools/cost.js';
import { registerExecutionTools } from './tools/executions.js';
import { registerContextTools, type ContextToolDeps } from './tools/context.js';
import { registerScheduleTools } from './tools/schedule.js';
import { executionRepo } from '@store/execution-repo.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';

const log = createLogger('mcp-server');

// --- Config from env / CLI args ---

function getCliArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefixed = process.argv.find(a => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  return null;
}

const routeContextFile: string | null =
  getCliArg('--route-context-file') ||
  process.env.CORTEX_ROUTE_CONTEXT_FILE ||
  null;

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-ext', version: CORTEX_VERSION });

const contextDeps: ContextToolDeps = { routeContextFile };

registerCostTools(server);
registerExecutionTools(server);
registerContextTools(server, contextDeps);
registerScheduleTools(server, contextDeps);

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
