// input:  MCP SDK, TUI plan/ask registrars, route identity, and webhook transport
// output: Claude-TUI bridge stdio service assembled from production registrations
// pos:    DR-0012 bridge loaded only by Claude TUI sessions; no exported name inventory
// NOTE: "TUI" here refers to Claude CLI's Ink terminal mode (DR-0012), not to the upcoming Cortex TUI.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerTuiPlanTools, type TuiToolDeps } from './tools/tui-plan.js';
import { registerTuiAskTools } from './tools/tui-ask.js';

const log = createLogger('mcp-tui');

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

const deps: TuiToolDeps = {
  channel,
  sessionId,
  threadId,
  webhookBaseUrl,
  httpPost: defaultHttpPost,
};

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-tui-bridge', version: CORTEX_VERSION });

registerTuiPlanTools(server, deps);
registerTuiAskTools(server, deps);

// --- Start (called by barrel when run as standalone) ---

export async function startServer(): Promise<void> {
  if (!channel) {
    log.warn('SLACK_CHANNEL not set — cortex_plan_exit / cortex_ask_user will error out at call time');
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
