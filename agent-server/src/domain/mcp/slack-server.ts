// input:  MCP SDK, Slack WebClient, environment routing, and Slack tool registrar
// output: Slack-specific MCP stdio service assembled from production registration
// pos:    standalone platform server loaded only for Slack-originated
//         sessions (channel carries the `slack:` prefix) — Claude via mcp-config-slack.json layering,
//         PI via the mcp-bridge slack handle. Not loaded for thread/core sessions.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebClient } from '@slack/web-api';
import { registerSlackTools } from './tools/slack.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';

const log = createLogger('mcp-slack');

// --- Config from env / CLI args ---

const token = process.env.SLACK_BOT_TOKEN;
const fallbackChannel = process.env.SLACK_CHANNEL;
const branchMachine: string | undefined = process.env.CORTEX_BRANCH_MACHINE;
const fallbackCallbackSource: string | undefined = process.env.CORTEX_CALLBACK_SOURCE;

// --- Slack client ---

const slack: WebClient | null = token ? new WebClient(token) : null;

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-slack', version: CORTEX_VERSION });

registerSlackTools(server, {
  slack,
  fallbackChannel,
  routeContextFile: null,
  branchMachine,
  callbackSource: fallbackCallbackSource,
});

// --- Start (called by barrel when run as standalone) ---

export async function startServer(): Promise<void> {
  if (!token || !fallbackChannel) {
    log.warn('SLACK_BOT_TOKEN or SLACK_CHANNEL not set — slack_send_file will be unavailable');
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { uploadFileToSlack } from './tools/slack.js';

if (isMainModule(import.meta.url)) {
  startServer().catch((e) => {
    log.error(e);
    process.exit(1);
  });
}
