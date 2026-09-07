// input:  MCP SDK, tool gate, env-built tool context, Slack registrar
// output: Slack-specific MCP stdio service assembled from production registration
// pos:    standalone platform server loaded only for Slack-originated
//         sessions (channel carries the `slack:` prefix) — Claude via mcp-config-slack.json layering,
//         PI via the mcp-bridge slack handle. Not loaded for thread/core sessions.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSlackTools, slackDepsFor } from './tools/slack.js';
import { toolContextFromEnv } from './tools/context.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';

const log = createLogger('mcp-slack');

// --- Session context from env; Slack client built from it ---

const ctx = toolContextFromEnv();
const deps = slackDepsFor(ctx);

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-slack', version: CORTEX_VERSION });

registerGatedMcpTools(server, target => registerSlackTools(target, deps), ctx.toolAllowlist);

// --- Start (called by barrel when run as standalone) ---

export async function startServer(): Promise<void> {
  if (!deps.slack || !deps.fallbackChannel) {
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
