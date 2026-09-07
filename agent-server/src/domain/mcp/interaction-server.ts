// input:  MCP SDK, tool gate, env-built tool context, interaction registrars
// output: Shared blocking interaction MCP stdio service
// pos:    Serves human questions and plan approval to agents
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { registerInteractionPlanTools, interactionDepsFor } from './tools/interaction-plan.js';
import { registerCommissionTools } from './tools/commission-tools.js';
import { registerInteractionAskTools } from './tools/interaction-ask.js';
import { toolContextFromEnv } from './tools/context.js';

const log = createLogger('mcp-interaction');

// --- Session context from env at module load time ---

const ctx = toolContextFromEnv();
const deps = interactionDepsFor(ctx);

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-interaction-bridge', version: CORTEX_VERSION });

registerGatedMcpTools(server, (target) => {
  registerInteractionPlanTools(target, deps);
  registerCommissionTools(target, deps);
  registerInteractionAskTools(target, deps);
}, ctx.toolAllowlist);

// --- Start (called by barrel when run as standalone) ---

export async function startServer(): Promise<void> {
  if (!ctx.channel) {
    log.warn('interaction channel not set — plan and question tools will fail at call time');
  }
  if (!ctx.sessionId) {
    log.warn('CORTEX_SESSION_ID not set — webhook will receive null sessionId');
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  startServer().catch((e) => {
    log.error(e);
    process.exit(1);
  });
}
