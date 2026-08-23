// input:  MCP SDK, tool gate, interaction registrars, webhook
// output: Shared blocking interaction MCP stdio service
// pos:    Serves human questions and plan approval to agents
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { registerInteractionPlanTools, type InteractionToolDeps } from './tools/interaction-plan.js';
import { registerInteractionAskTools } from './tools/interaction-ask.js';

const log = createLogger('mcp-interaction');

// --- Resolve env-driven deps at module load time ---

const channel = process.env.SLACK_CHANNEL ?? null;
const sessionId = process.env.CORTEX_SESSION_ID ?? null;
const threadId = process.env.CORTEX_THREAD_ID ?? null;
const webhookPort = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
const webhookBaseUrl = `http://127.0.0.1:${webhookPort}`;

/** Production HTTP POST using node:http — the webhook endpoints block until user interaction
 *  completes (up to 30 min). Node's global fetch (undici) has a 300s headersTimeout that fires
 *  before the user can respond; http.request with an explicit 60-min timeout avoids this. */
async function defaultHttpPost(url: string, body: any): Promise<{ status: number; body: any }> {
  const jsonBody = JSON.stringify(body);
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonBody),
        'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '',
      },
      timeout: 60 * 60 * 1000, // 60 minutes — user may take time to respond
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = { _raw: data }; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(jsonBody);
    req.end();
  });
}

const deps: InteractionToolDeps = {
  channel,
  sessionId,
  threadId,
  webhookBaseUrl,
  httpPost: defaultHttpPost,
};

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-interaction-bridge', version: CORTEX_VERSION });

registerGatedMcpTools(server, (target) => {
  registerInteractionPlanTools(target, deps);
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
