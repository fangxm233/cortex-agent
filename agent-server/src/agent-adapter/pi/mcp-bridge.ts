// input:  PI API, session env, plugin MCP configs, tool gates
// output: Bundled Cortex tools (in-process) and independent plugin MCP tools
// pos:    Bridges MCP servers into PI tools
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Type } from '@sinclair/typebox';
import { createLogger } from '@core/log.js';
import { MCP_INFRASTRUCTURE_TIMEOUT_MS } from '@core/mcp-timeout.js';
import type { McpBundleName } from '@core/mcp-bundles.js';
import {
  MCP_TOOL_ALLOWLIST_ENV, MCP_TOOLS_BY_SERVER, parseMcpToolAllowlist,
  validateMcpToolAllowlist, withoutCommissionTools,
} from '@core/mcp-tool-gate.js';
import type { McpServerConfig } from '../types.js';
import { createRedirectRejectingFetch } from '../mcp-remote-fetch.js';
import {
  mapMcpContent,
  shouldLoadFeishu,
  shouldLoadSlack,
  shouldLoadThreadControl,
  shouldLoadWeb,
} from './mcp-bridge-logic.js';
import {
  PI_COMMISSION_TOOLS_ENV, PI_INTERACTION_BRIDGE_ENV, PI_MCP_COMPOSITION_ENV,
} from './spawn-args.js';
import { safeNativeComposite, safeNativeName } from '../../domain/plugins/native-name.js';
import { createBundledServer } from '../../domain/mcp/bundled-server.js';
import { toolContextFromEnv } from '../../domain/mcp/tools/context.js';

const log = createLogger('pi-mcp-bridge');

type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type BridgeClient = Pick<Client, 'listTools' | 'callTool'>;

export interface McpClientHandle {
  client: BridgeClient;
  transport: Pick<Transport, 'close'>;
}

/** Where a bridged server comes from: Cortex's own bundles served in-process, or a plugin's
 *  external server reached over its declared transport. */
export type McpServerSource =
  | { kind: 'bundled'; bundles: McpBundleName[]; env: Record<string, string> }
  | { kind: 'plugin'; config: McpServerConfig };

export interface ServerState {
  name: string;
  source: McpServerSource;
  handle: McpClientHandle | null;
  registered: boolean;
  registeredToolNames: Set<string>;
}

type StateDiscovery =
  | { state: ServerState; status: 'skip' }
  | { state: ServerState; status: 'ready'; tools: McpTool[] }
  | { state: ServerState; status: 'failed'; failure: unknown };

export interface McpBridgeDeps {
  /** The session's environment: composition markers, channel, Cortex context, tool gate. */
  env: NodeJS.ProcessEnv;
  /** Plugin (and browser) servers for this session, already filtered by composition. */
  pluginServers?: readonly McpServerConfig[];
  spawnClient(state: ServerState): Promise<McpClientHandle>;
  reportFailure(error: unknown): void;
}

export interface McpTransportConstructors {
  stdio(server: StdioServerParameters): Transport;
  streamableHttp(url: URL, options: StreamableHTTPClientTransportOptions): Transport;
  sse(url: URL, options: SSEClientTransportOptions): Transport;
}

const DEFAULT_TRANSPORT_CONSTRUCTORS: McpTransportConstructors = {
  stdio: (server) => new StdioClientTransport(server),
  streamableHttp: (url, options) => new StreamableHTTPClientTransport(url, options),
  sse: (url, options) => new SSEClientTransport(url, options),
};

function builtinEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...env,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN || '',
    SLACK_CHANNEL: env.SLACK_CHANNEL || '',
    FEISHU_CHANNEL: env.FEISHU_CHANNEL || '',
  } as Record<string, string>;
}

/**
 * PI has no `--tools` equivalent for MCP tools, so the allowlist is its only lever — and the gate is
 * fail-open, meaning "hide a tool" has to be spelled out as an allowlist spanning every selected
 * bundle. This runs here rather than in the adapter because this is the first place that knows PI's
 * bundle set. A session drafting a commission gets no allowlist at all: it is allowed everything,
 * including the two commission tools.
 */
function commissionGatedEnv(
  bundles: readonly McpBundleName[], env: NodeJS.ProcessEnv,
): Record<string, string> {
  const toolEnv = builtinEnv(env);
  if (!bundles.includes('cortex-interaction-bridge')) return toolEnv;
  if (env[PI_COMMISSION_TOOLS_ENV] === '1') return toolEnv;
  const declared = parseMcpToolAllowlist(env[MCP_TOOL_ALLOWLIST_ENV]);
  toolEnv[MCP_TOOL_ALLOWLIST_ENV] = JSON.stringify(
    withoutCommissionTools(declared ? [...declared] : undefined, bundles),
  );
  return toolEnv;
}

function createState(name: string, source: McpServerSource): ServerState {
  return {
    name,
    source,
    handle: null,
    registered: false,
    registeredToolNames: new Set<string>(),
  };
}

function assertUniqueServerStateNames(states: ServerState[]): ServerState[] {
  const seen = new Set<string>();
  for (const state of states) {
    if (seen.has(state.name)) throw new Error(`Duplicate MCP server state name: ${state.name}`);
    seen.add(state.name);
  }
  return states;
}

function validateToolGatedStates(
  env: NodeJS.ProcessEnv, states: ServerState[],
): ServerState[] {
  const allowlist = parseMcpToolAllowlist(env[MCP_TOOL_ALLOWLIST_ENV]);
  if (allowlist === null) return states;
  const core = states.find(state => state.name === 'core');
  const bundles = core?.source.kind === 'bundled' ? core.source.bundles : [];
  const known = new Set(bundles.flatMap(bundle => MCP_TOOLS_BY_SERVER[bundle] ?? []));
  validateMcpToolAllowlist([...allowlist], known);
  return states;
}

function optionalBundles(env: NodeJS.ProcessEnv): McpBundleName[] {
  const channel = env.SLACK_CHANNEL;
  const optional: Array<[boolean, McpBundleName]> = [
    [shouldLoadThreadControl(env.CORTEX_THREAD_ID), 'cortex-thread'],
    [true, 'cortex-ext'],
    [shouldLoadSlack(channel), 'cortex-slack'],
    [shouldLoadFeishu(channel), 'cortex-feishu'],
    [shouldLoadWeb(channel), 'cortex-web'],
  ];
  return optional.filter(([enabled]) => enabled).map(([, bundle]) => bundle);
}

function pluginStates(
  servers: readonly McpServerConfig[],
  reportIssue: (message: string) => void,
): ServerState[] {
  const states: ServerState[] = [];
  const seen = new Set<string>();
  const ordered = servers.slice().sort((left, right) => left.name.localeCompare(right.name));
  for (const server of ordered) {
    const stateName = pluginServerStateName(server.name);
    if (seen.has(stateName)) {
      reportIssue(`Duplicate MCP server state name: ${stateName}`);
      continue;
    }
    seen.add(stateName);
    states.push(createState(stateName, { kind: 'plugin', config: server }));
  }
  return states;
}

/** Build the server set before connecting any MCP transport. */
export function buildServerStates(
  env: NodeJS.ProcessEnv,
  pluginServers: readonly McpServerConfig[] = [],
  reportIssue: (message: string) => void = () => undefined,
): ServerState[] {
  const composition = env[PI_MCP_COMPOSITION_ENV];
  if (composition === 'none') return validateToolGatedStates(env, []);
  const bundles: McpBundleName[] = ['cortex-core'];
  if (env.CORTEX_PI_SUBAGENT !== '1') {
    bundles.push('cortex-tasks', 'cortex-manager-qa');
    if (composition === 'direct' && env[PI_INTERACTION_BRIDGE_ENV] === '1') {
      bundles.push('cortex-interaction-bridge');
    }
    bundles.push(...optionalBundles(env));
  }
  const states = [createState('core', { kind: 'bundled', bundles, env: commissionGatedEnv(bundles, env) })];
  if (env.CORTEX_PI_SUBAGENT !== '1') states.push(...pluginStates(pluginServers, reportIssue));
  return validateToolGatedStates(env, assertUniqueServerStateNames(states));
}

function serverFailure(name: string, action: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`MCP server ${name} ${action} failed: ${detail}`, { cause });
}

function reportBridgeFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  log.warn(`MCP setup failed; will retry on next turn: ${message}`);
}

export function pluginServerStateName(serverName: string): string {
  return safeNativeName(`plugin_server_${serverName}`, 'plugin_server');
}

export function pluginToolName(serverStateName: string, toolName: string): string {
  return safeNativeComposite([serverStateName, toolName], 'plugin_tool');
}

function exposedToolName(state: ServerState, toolName: string): string {
  return state.source.kind === 'bundled' ? toolName : pluginToolName(state.name, toolName);
}

export const createSameOriginFetch = createRedirectRejectingFetch;

/** Transport for one plugin server. A stdio server inherits `baseEnv` (the session's environment,
 *  not the daemon's) beneath its own declared variables. */
export function createMcpTransport(
  config: McpServerConfig,
  constructors: McpTransportConstructors = DEFAULT_TRANSPORT_CONSTRUCTORS,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Transport {
  if (config.type === 'stdio') {
    return constructors.stdio({
      command: config.command,
      args: [...config.args],
      env: { ...baseEnv, ...config.env } as Record<string, string>,
      cwd: config.cwd,
      stderr: 'pipe',
    });
  }
  const headers = { ...config.headers };
  const fetchWithHeaders = createSameOriginFetch(headers);
  if (config.type === 'streamable-http') {
    return constructors.streamableHttp(new URL(config.url), { requestInit: { headers }, fetch: fetchWithHeaders });
  }
  return constructors.sse(new URL(config.url), {
    fetch: fetchWithHeaders,
    eventSourceInit: { fetch: fetchWithHeaders },
    requestInit: { headers },
  });
}

/** Cortex's bundles served over an in-memory transport pair: same McpServer the stdio entries
 *  build, bound to a tool context derived from the session's environment, no child process. */
async function connectBundledServer(
  state: ServerState, bundles: McpBundleName[], env: Record<string, string>,
): Promise<McpClientHandle> {
  const server = await createBundledServer(bundles, toolContextFromEnv(env));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `pi-mcp-bridge-${state.name}`, version: '1.0.0' });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
  } catch (error) {
    try { await server.close(); } catch { /* best-effort */ }
    throw error;
  }
  return {
    client,
    transport: {
      close: async () => {
        try { await clientTransport.close(); } finally { await server.close(); }
      },
    },
  };
}

async function connectPluginServer(
  state: ServerState, config: McpServerConfig, baseEnv: NodeJS.ProcessEnv,
): Promise<McpClientHandle> {
  const transport = createMcpTransport(config, DEFAULT_TRANSPORT_CONSTRUCTORS, baseEnv);
  const client = new Client({ name: `pi-mcp-bridge-${state.name}`, version: '1.0.0' });
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    try { await transport.close(); } catch { /* best-effort */ }
    throw error;
  }
}

/** Production dependencies for one session: bundles in-process, plugins over their transports. */
export function createMcpBridgeDeps(
  env: NodeJS.ProcessEnv,
  pluginServers: readonly McpServerConfig[] = [],
): McpBridgeDeps {
  return {
    env,
    pluginServers,
    spawnClient: (state) => state.source.kind === 'bundled'
      ? connectBundledServer(state, state.source.bundles, state.source.env)
      : connectPluginServer(state, state.source.config, env),
    reportFailure: reportBridgeFailure,
  };
}

class McpBridgeSession {
  private states: ServerState[] | null = null;
  private readonly registeredNames = new Map<string, string>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly deps: McpBridgeDeps,
  ) {}

  install(): void {
    this.pi.on('before_agent_start', async () => this.beforeAgentStart());
    this.pi.on('session_shutdown', async () => this.shutdown());
  }

  private resolveStates(): ServerState[] {
    if (this.states) return this.states;
    this.states = buildServerStates(
      this.deps.env,
      this.deps.pluginServers ?? [],
      (message) => this.deps.reportFailure(new Error(message)),
    );
    return this.states;
  }

  private resolveStatesSafely(): ServerState[] | null {
    try {
      return this.resolveStates();
    } catch (error) {
      this.deps.reportFailure(error);
      return null;
    }
  }

  private async discoverState(state: ServerState): Promise<StateDiscovery> {
    if (state.registered) return { state, status: 'skip' };
    try {
      await this.connect(state);
      const tools = await this.listTools(state);
      return { state, status: 'ready', tools };
    } catch (failure) {
      return { state, status: 'failed', failure };
    }
  }

  private finalizeDiscovery(discovery: StateDiscovery): void {
    if (discovery.status === 'skip') return;
    if (discovery.status === 'failed') {
      this.deps.reportFailure(discovery.failure);
      return;
    }
    try {
      this.registerDiscoveredTools(discovery.state, discovery.tools);
    } catch (failure) {
      this.deps.reportFailure(failure);
    }
  }

  private async beforeAgentStart(): Promise<void> {
    const states = this.resolveStatesSafely();
    if (!states) return;
    const discoveries = states.map((state) => this.discoverState(state));
    // Discovery is concurrent; ordered awaiting keeps duplicate tool ownership deterministic.
    for (const discovery of discoveries) this.finalizeDiscovery(await discovery);
  }

  private async connect(state: ServerState): Promise<void> {
    if (state.handle) return;
    try {
      state.handle = await this.deps.spawnClient(state);
    } catch (error) {
      throw serverFailure(state.name, 'connect', error);
    }
  }

  private async listTools(state: ServerState): Promise<McpTool[]> {
    if (!state.handle) throw new Error(`MCP server ${state.name} is not connected`);
    try {
      const { tools } = await state.handle.client.listTools();
      return tools;
    } catch (error) {
      throw serverFailure(state.name, 'list tools', error);
    }
  }

  private discoveredTools(state: ServerState, tools: McpTool[]): Map<string, McpTool> {
    const discovered = new Map<string, McpTool>();
    for (const tool of tools) {
      const name = exposedToolName(state, tool.name);
      if (discovered.has(name)) {
        throw serverFailure(state.name, 'register tools', new Error(`Duplicate MCP tool name: ${name}`));
      }
      discovered.set(name, tool);
    }
    return discovered;
  }

  private toolOwnedElsewhere(state: ServerState, name: string): boolean {
    const owner = this.registeredNames.get(name);
    return Boolean(owner && owner !== state.name);
  }

  private registerNewTool(state: ServerState, name: string, tool: McpTool): void {
    try {
      this.registerTool(state, name, tool);
    } catch (error) {
      throw serverFailure(state.name, 'register tools', error);
    }
    state.registeredToolNames.add(name);
    this.registeredNames.set(name, state.name);
  }

  private registerDiscoveredTool(state: ServerState, name: string, tool: McpTool): void {
    if (this.toolOwnedElsewhere(state, name)) return;
    if (state.registeredToolNames.has(name)) return;
    this.registerNewTool(state, name, tool);
  }

  private registerDiscoveredTools(state: ServerState, tools: McpTool[]): void {
    for (const [name, tool] of this.discoveredTools(state, tools)) {
      this.registerDiscoveredTool(state, name, tool);
    }
    state.registered = true;
  }

  private registerTool(state: ServerState, exposedName: string, tool: McpTool): void {
    if (!state.handle) throw new Error(`MCP server ${state.name} is not connected`);
    const parameters = Type.Unsafe(tool.inputSchema as Record<string, unknown>);
    const handle = state.handle;
    this.pi.registerTool({
      name: exposedName,
      label: exposedName,
      description: tool.description ?? '',
      parameters,
      async execute(_id, params, signal) {
        const result = await handle.client.callTool(
          { name: tool.name, arguments: params as Record<string, unknown> },
          undefined,
          {
            ...(signal ? { signal } : {}),
            timeout: MCP_INFRASTRUCTURE_TIMEOUT_MS,
            maxTotalTimeout: MCP_INFRASTRUCTURE_TIMEOUT_MS,
          },
        );
        const content = (result.content as any[]).map(mapMcpContent);
        if (result.isError) {
          const message = content.map(item => item.text).filter(Boolean).join('\n');
          throw new Error(message || `${exposedName} failed`);
        }
        return { content, details: undefined };
      },
    });
  }

  private async shutdown(): Promise<void> {
    const states = this.states ?? [];
    this.registeredNames.clear();
    for (const state of states) {
      state.registered = false;
      state.registeredToolNames.clear();
      if (state.handle) {
        try { await state.handle.transport.close(); } catch { /* best-effort */ }
      }
      state.handle = null;
    }
  }
}

export async function installMcpBridge(pi: ExtensionAPI, deps: McpBridgeDeps): Promise<void> {
  new McpBridgeSession(pi, deps).install();
}
