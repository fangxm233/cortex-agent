// input:  MCP SDK, tool gate, interaction registrars, webhook
// output: Shared blocking interaction MCP stdio service
// pos:    Serves human questions and plan approval to agents
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { registerInteractionPlanTools, type InteractionToolDeps } from './tools/interaction-plan.js';
import { registerCommissionPlanTools } from './tools/commission-plan.js';
import { registerInteractionAskTools } from './tools/interaction-ask.js';

const log = createLogger('mcp-interaction');

// --- Resolve env-driven deps at module load time ---

const channel = process.env.SLACK_CHANNEL ?? null;
const sessionId = process.env.CORTEX_SESSION_ID ?? null;
const sessionName = process.env.CORTEX_SESSION_NAME ?? null;
const threadId = process.env.CORTEX_THREAD_ID ?? null;
const webhookPort = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
const webhookBaseUrl = `http://127.0.0.1:${webhookPort}`;

/** Interaction webhooks block up to the 30-minute business TTL. The shared loopback helper
 *  adds the infrastructure grace without inheriting Node fetch's shorter hidden deadline. */
async function defaultHttpPost(url: string, body: any): Promise<{ status: number; body: any }> {
  return requestLoopbackJson('POST', url, body, {
    'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '',
  });
}

const deps: InteractionToolDeps = {
  channel,
  sessionId,
  sessionName,
  threadId,
  webhookBaseUrl,
  httpPost: defaultHttpPost,
};

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-interaction-bridge', version: CORTEX_VERSION });

registerGatedMcpTools(server, (target) => {
  registerInteractionPlanTools(target, deps);
  registerCommissionPlanTools(target, deps);
  registerInteractionAskTools(target, deps);
});

// --- Start (called by barrel when run as standalone) ---

export async function startServer(): Promise<void> {
  if (!channel) {
    log.warn('interaction channel not set — plan and question tools will fail at call time');
  }
  if (!sessionId) {
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
