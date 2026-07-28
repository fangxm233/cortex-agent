// input:  PI ExtensionAPI, MCP clients, and pure platform/content bridge policy
// output: discovered Cortex tools registered into PI with transparent call forwarding
// pos:    PI extension lifecycle; paths and process handles stay private
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ExtensionAPI } from './pi-ext-types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Type } from '@sinclair/typebox';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapMcpContent,
  shouldLoadFeishu,
  shouldLoadSlack,
  shouldLoadWeb,
} from './mcp-bridge-logic.js';

// __dirname is provided by PI's jiti CJS compat layer when loading .ts extension files.
// In ESM contexts (agent-server tests via tsx), derive it from import.meta.url instead.
// eslint-disable-next-line no-undef
const _dirname: string = (typeof __dirname === 'string' ? __dirname : null) ?? dirname(fileURLToPath(import.meta.url));
// Once compiled, this file lives at dist/agent-adapter/pi/mcp-bridge.js; sibling MCP servers
// live at dist/domain/mcp/{core-server,server,slack-server,feishu-server}.js. Point at the compiled .js so the
// installed package (which does not ship src/) can locate them.
const CORE_SERVER_PATH = resolve(_dirname, '../../domain/mcp/core-server.js');
const EXT_SERVER_PATH = resolve(_dirname, '../../domain/mcp/server.js');
const SLACK_SERVER_PATH = resolve(_dirname, '../../domain/mcp/slack-server.js');
const FEISHU_SERVER_PATH = resolve(_dirname, '../../domain/mcp/feishu-server.js');
const WEB_SERVER_PATH = resolve(_dirname, '../../domain/mcp/web-server.js');

// --- MCP client wrapper (one per server) ---

interface McpClientHandle {
  client: Client;
  transport: Transport;
}

async function spawnMcpClient(serverPath: string, serverName: string): Promise<McpClientHandle> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    stderr: 'pipe',
    env: {
      ...process.env,
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
      SLACK_CHANNEL: process.env.SLACK_CHANNEL || '',
      FEISHU_CHANNEL: process.env.SLACK_CHANNEL || '',
    },
  });
  const client = new Client({ name: `pi-mcp-bridge-${serverName}`, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

// --- PI extension factory ---

export default async function mcpBridge(pi: ExtensionAPI): Promise<void> {
  let coreHandle: McpClientHandle | null = null;
  let extHandle: McpClientHandle | null = null;
  let slackHandle: McpClientHandle | null = null;
  let feishuHandle: McpClientHandle | null = null;
  let webHandle: McpClientHandle | null = null;
  let toolsRegistered = false;

  // The source channel is forwarded by the PI adapter as SLACK_CHANNEL (see pi/adapter.ts spawn env).
  const loadSlack = shouldLoadSlack(process.env.SLACK_CHANNEL);
  const loadFeishu = shouldLoadFeishu(process.env.SLACK_CHANNEL);
  const loadWeb = shouldLoadWeb(process.env.SLACK_CHANNEL);

  async function ensureAllConnected(): Promise<void> {
    // Spawn core server (remote_* tools) — always loaded
    if (!coreHandle) {
      coreHandle = await spawnMcpClient(CORE_SERVER_PATH, 'core').catch(() => null);
    }
    // Spawn ext server (everything else: cost, context, schedule)
    if (!extHandle) {
      extHandle = await spawnMcpClient(EXT_SERVER_PATH, 'ext').catch(() => null);
    }
    // Spawn slack server (slack_send_file tool) only for Slack-originated sessions.
    if (loadSlack && !slackHandle) {
      slackHandle = await spawnMcpClient(SLACK_SERVER_PATH, 'slack').catch(() => null);
    }
    // Spawn feishu server (Feishu document tools) only for Feishu-originated sessions.
    if (loadFeishu && !feishuHandle) {
      feishuHandle = await spawnMcpClient(FEISHU_SERVER_PATH, 'feishu').catch(() => null);
    }
    // Spawn web server (send_file tool) only for Web-UI-originated sessions.
    if (loadWeb && !webHandle) {
      webHandle = await spawnMcpClient(WEB_SERVER_PATH, 'web').catch(() => null);
    }
  }

  async function registerToolsFrom(handle: McpClientHandle): Promise<void> {
    let toolList: Awaited<ReturnType<Client['listTools']>>['tools'];
    try {
      ({ tools: toolList } = await handle.client.listTools());
    } catch {
      return;
    }
    for (const tool of toolList) {
      const toolName = tool.name;
      const toolDesc = tool.description ?? '';
      const parameters = Type.Unsafe(tool.inputSchema as Record<string, unknown>);
      pi.registerTool({
        name: toolName,
        label: toolName,
        description: toolDesc,
        parameters,
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          _signal: AbortSignal | undefined,
          _onUpdate: any,
          _ctx: any,
        ) {
          const result = await handle.client.callTool({
            name: toolName,
            arguments: params,
          });
          const content = (result.content as any[]).map(mapMcpContent);
          return { content, details: { isError: result.isError ?? false } };
        },
      });
    }
  }

  // Discover and register tools on the first before_agent_start of each session.
  pi.on('before_agent_start', async (_event, _ctx) => {
    if (toolsRegistered) return;

    try {
      await ensureAllConnected();
    } catch {
      return;  // Don't crash PI if MCP servers fail to start
    }

    // Register from core server (remote_*)
    if (coreHandle) await registerToolsFrom(coreHandle);
    // Register from ext server (cost, context, schedule)
    if (extHandle) await registerToolsFrom(extHandle);
    // Register from slack server (slack_send_file) — Slack-originated sessions only
    if (slackHandle) await registerToolsFrom(slackHandle);
    // Register from feishu server (Feishu document tools) — Feishu-originated sessions only
    if (feishuHandle) await registerToolsFrom(feishuHandle);
    // Register from web server (send_file) — Web-UI-originated sessions only
    if (webHandle) await registerToolsFrom(webHandle);

    toolsRegistered = true;
  });

  // Clean up MCP subprocesses when the PI session ends.
  pi.on('session_shutdown', async (_event, _ctx) => {
    toolsRegistered = false;
    for (const h of [coreHandle, extHandle, slackHandle, feishuHandle, webHandle]) {
      if (h) {
        try { await h.transport.close(); } catch { /* best-effort */ }
      }
    }
    coreHandle = null;
    extHandle = null;
    slackHandle = null;
    feishuHandle = null;
    webHandle = null;
  });
}
