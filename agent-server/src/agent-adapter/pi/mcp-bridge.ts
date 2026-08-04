// input:  PI extension API, MCP clients, privilege context
// output: Retryable scoped Cortex MCP tools in PI
// pos:    PI MCP subprocess and tool-registration bridge
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ExtensionAPI } from './pi-ext-types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Type } from '@sinclair/typebox';
import { createLogger } from '@core/log.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapMcpContent,
  shouldLoadFeishu,
  shouldLoadSlack,
  shouldLoadThreadControl,
  shouldLoadWeb,
} from './mcp-bridge-logic.js';
import { benchmarkCallOptions, remainingTrialMs } from './mcp-duration.js';
import { PI_MCP_COMPOSITION_ENV } from './policy-guard.js';

// __dirname is provided by PI's jiti CJS compat layer when loading .ts extension files.
// In ESM contexts (agent-server tests via tsx), derive it from import.meta.url instead.
// eslint-disable-next-line no-undef
const _dirname: string = (typeof __dirname === 'string' ? __dirname : null) ?? dirname(fileURLToPath(import.meta.url));
// Point at compiled siblings because installed packages do not ship src/.
const CORE_SERVER_PATH = resolve(_dirname, '../../domain/mcp/core-server.js');
const TASKS_SERVER_PATH = resolve(_dirname, '../../domain/mcp/tasks-server.js');
const MANAGER_QA_SERVER_PATH = resolve(_dirname, '../../domain/mcp/manager-qa-server.js');
const THREAD_SERVER_PATH = resolve(_dirname, '../../domain/mcp/thread-server.js');
const EXT_SERVER_PATH = resolve(_dirname, '../../domain/mcp/server.js');
const SLACK_SERVER_PATH = resolve(_dirname, '../../domain/mcp/slack-server.js');
const FEISHU_SERVER_PATH = resolve(_dirname, '../../domain/mcp/feishu-server.js');
const WEB_SERVER_PATH = resolve(_dirname, '../../domain/mcp/web-server.js');
const BENCHMARK_THREAD_SERVER_PATH = resolve(_dirname, '../../domain/mcp/benchmark-thread-server.js');

/** The one server `benchmark-thread-run` exposes, named as the Claude-side config names it. */
export const BENCHMARK_THREAD_SERVER_NAME = 'cortex-benchmark-thread';

const log = createLogger('pi-mcp-bridge');

type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type BridgeClient = Pick<Client, 'listTools' | 'callTool'>;

export interface McpClientHandle {
  client: BridgeClient;
  transport: Pick<Transport, 'close'>;
}

export interface McpBridgeDeps {
  env: NodeJS.ProcessEnv;
  spawnClient(serverPath: string, serverName: string): Promise<McpClientHandle>;
  reportFailure(error: unknown): void;
}

export interface ServerState {
  name: string;
  path: string;
  handle: McpClientHandle | null;
}

interface DiscoveredSurface {
  handle: McpClientHandle;
  tools: McpTool[];
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
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    try { await transport.close(); } catch { /* best-effort */ }
    throw error;
  }
}

/**
 * §5.6 P1: under a restricted composition the server set is the composition's and nothing else —
 * decided before any ambient switch is consulted, so a stray `CORTEX_THREAD_ID` or `SLACK_CHANNEL`
 * in the child environment cannot layer a server onto a benchmark trial.
 */
export function buildServerStates(env: NodeJS.ProcessEnv): ServerState[] {
  const composition = env[PI_MCP_COMPOSITION_ENV];
  if (composition === 'none') return [];
  if (composition === 'benchmark-thread-run') {
    return [{ name: BENCHMARK_THREAD_SERVER_NAME, path: BENCHMARK_THREAD_SERVER_PATH, handle: null }];
  }
  const core: ServerState = { name: 'core', path: CORE_SERVER_PATH, handle: null };
  if (env.CORTEX_PI_SUBAGENT === '1') return [core];
  const channel = env.SLACK_CHANNEL;
  const states: ServerState[] = [
    core,
    { name: 'tasks', path: TASKS_SERVER_PATH, handle: null },
    { name: 'manager-qa', path: MANAGER_QA_SERVER_PATH, handle: null },
  ];
  const optional: Array<[boolean, ServerState]> = [
    [shouldLoadThreadControl(env.CORTEX_THREAD_ID), { name: 'thread', path: THREAD_SERVER_PATH, handle: null }],
    [true, { name: 'ext', path: EXT_SERVER_PATH, handle: null }],
    [shouldLoadSlack(channel), { name: 'slack', path: SLACK_SERVER_PATH, handle: null }],
    [shouldLoadFeishu(channel), { name: 'feishu', path: FEISHU_SERVER_PATH, handle: null }],
    [shouldLoadWeb(channel), { name: 'web', path: WEB_SERVER_PATH, handle: null }],
  ];
  for (const [enabled, state] of optional) {
    if (enabled) states.push(state);
  }
  return states;
}

function serverFailure(name: string, action: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`MCP server ${name} ${action} failed: ${detail}`, { cause });
}

function reportBridgeFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  log.warn(`MCP setup failed; will retry on next turn: ${message}`);
}

const DEFAULT_DEPS: McpBridgeDeps = {
  env: process.env,
  spawnClient: spawnMcpClient,
  reportFailure: reportBridgeFailure,
};

class McpBridgeSession {
  private readonly states: ServerState[];
  private readonly registeredNames = new Set<string>();
  private complete = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly deps: McpBridgeDeps,
  ) {
    this.states = buildServerStates(deps.env);
  }

  install(): void {
    this.pi.on('before_agent_start', async () => this.beforeAgentStart());
    this.pi.on('session_shutdown', async () => this.shutdown());
  }

  private async beforeAgentStart(): Promise<void> {
    if (this.complete) return;
    try {
      await this.connectAll();
      const discovered = await this.listAllTools();
      this.registerAll(discovered);
      this.complete = true;
    } catch (error) {
      this.deps.reportFailure(error);
    }
  }

  private async connectAll(): Promise<void> {
    for (const state of this.states) {
      if (state.handle) continue;
      try {
        state.handle = await this.deps.spawnClient(state.path, state.name);
      } catch (error) {
        throw serverFailure(state.name, 'connect', error);
      }
    }
  }

  private async listAllTools(): Promise<DiscoveredSurface[]> {
    const discovered: DiscoveredSurface[] = [];
    for (const state of this.states) {
      if (!state.handle) throw new Error(`MCP server ${state.name} is not connected`);
      try {
        const { tools } = await state.handle.client.listTools();
        discovered.push({ handle: state.handle, tools });
      } catch (error) {
        throw serverFailure(state.name, 'list tools', error);
      }
    }
    return discovered;
  }

  private registerAll(discovered: DiscoveredSurface[]): void {
    for (const surface of discovered) {
      for (const tool of surface.tools) {
        if (this.registeredNames.has(tool.name)) continue;
        this.registerTool(surface.handle, tool);
        this.registeredNames.add(tool.name);
      }
    }
  }

  /**
   * §5.6 P2/P5/P6: the options for one call, derived now. A trial deadline yields the explicit
   * bounded window; its absence yields signal forwarding alone, because this bridge has no mandate
   * to invent a ceiling for a daemon session.
   */
  private callOptions(signal: AbortSignal | undefined): RequestOptions {
    const remainingMs = remainingTrialMs(this.deps.env);
    if (remainingMs === null) return signal ? { signal } : {};
    return benchmarkCallOptions(remainingMs, signal, () => {});
  }

  private registerTool(handle: McpClientHandle, tool: McpTool): void {
    const parameters = Type.Unsafe(tool.inputSchema as Record<string, unknown>);
    const callOptions = (signal: AbortSignal | undefined): RequestOptions => this.callOptions(signal);
    this.pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? '',
      parameters,
      async execute(_id, params, signal) {
        const result = await handle.client.callTool(
          { name: tool.name, arguments: params as Record<string, unknown> },
          undefined,
          callOptions(signal),
        );
        const content = (result.content as any[]).map(mapMcpContent);
        return { content, details: { isError: result.isError ?? false } };
      },
    });
  }

  private async shutdown(): Promise<void> {
    this.complete = false;
    this.registeredNames.clear();
    for (const state of this.states) {
      if (state.handle) {
        try { await state.handle.transport.close(); } catch { /* best-effort */ }
      }
      state.handle = null;
    }
  }
}

export async function installMcpBridge(
  pi: ExtensionAPI,
  deps: McpBridgeDeps = DEFAULT_DEPS,
): Promise<void> {
  new McpBridgeSession(pi, deps).install();
}

export default async function mcpBridge(pi: ExtensionAPI): Promise<void> {
  await installMcpBridge(pi);
}
