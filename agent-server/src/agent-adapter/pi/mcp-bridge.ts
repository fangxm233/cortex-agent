// input:  PI API, MCP configs, tool gates, process env
// output: Bundled Cortex and independent plugin MCP tools
// pos:    Bridges MCP servers into PI tools
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ExtensionAPI } from './pi-ext-types.js';
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
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Type } from '@sinclair/typebox';
import { createLogger } from '@core/log.js';
import { MCP_INFRASTRUCTURE_TIMEOUT_MS } from '@core/mcp-timeout.js';
import { encodeMcpBundles, MCP_BUNDLES_ENV, parseMcpBundles, type McpBundleName } from '@core/mcp-bundles.js';
import {
  applyPlanToolVariant, MCP_TOOL_ALLOWLIST_ENV, MCP_TOOLS_BY_SERVER, parseMcpToolAllowlist,
  validateMcpToolAllowlist, type PlanToolVariant,
} from '@core/mcp-tool-gate.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  PI_INTERACTION_BRIDGE_ENV, PI_MCP_COMPOSITION_ENV, PI_PLAN_TOOL_VARIANT_ENV,
} from './spawn-args.js';
import {
  PI_PLUGIN_MCP_CONFIG_ENV,
  loadPiPluginMcpConfig,
  type PiPluginMcpConfigIssue,
  type PiPluginMcpConfigLoadResult,
} from './mcp-config.js';
import { safeNativeComposite, safeNativeName } from '../../domain/plugins/native-name.js';

export { PI_PLUGIN_MCP_CONFIG_ENV } from './mcp-config.js';

// __dirname is provided by PI's jiti CJS compat layer when loading .ts extension files.
// In ESM contexts (agent-server tests via tsx), derive it from import.meta.url instead.
// eslint-disable-next-line no-undef
const _dirname: string = (typeof __dirname === 'string' ? __dirname : null) ?? dirname(fileURLToPath(import.meta.url));
// Point at compiled siblings because installed packages do not ship src/.
const BUNDLED_SERVER_PATH = resolve(_dirname, '../../domain/mcp/bundled-server.js');

const log = createLogger('pi-mcp-bridge');

type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type BridgeClient = Pick<Client, 'listTools' | 'callTool'>;

export interface McpClientHandle {
  client: BridgeClient;
  transport: Pick<Transport, 'close'>;
}

export interface ServerState {
  name: string;
  config: McpServerConfig;
  handle: McpClientHandle | null;
  registered: boolean;
  registeredToolNames: Set<string>;
}

type StateDiscovery =
  | { state: ServerState; status: 'skip' }
  | { state: ServerState; status: 'ready'; tools: McpTool[] }
  | { state: ServerState; status: 'failed'; failure: unknown };

type PluginConfigLoader = (configPath: string) => McpServerConfig[] | PiPluginMcpConfigLoadResult;

export interface BuildServerStatesOptions {
  loadPluginConfig?: PluginConfigLoader;
  reportPluginIssue?(issue: PiPluginMcpConfigIssue): void;
}

export interface McpBridgeDeps {
  env: NodeJS.ProcessEnv;
  spawnClient(state: ServerState): Promise<McpClientHandle>;
  reportFailure(error: unknown): void;
  loadPluginConfig?: PluginConfigLoader;
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

function readPlanToolVariant(env: NodeJS.ProcessEnv): PlanToolVariant | null {
  const raw = env[PI_PLAN_TOOL_VARIANT_ENV];
  return raw === 'standard' || raw === 'commission' ? raw : null;
}

/**
 * The plan-tool variant is applied here rather than in the adapter because this is the first place
 * that knows PI's bundle set — and the gate is fail-open, so excluding a tool means writing an
 * allowlist that spans every selected bundle, not just the interaction bridge. Only the commission
 * variant is narrowed: PI has no `--tools` equivalent for MCP tools, so this is the only lever that
 * can keep cortex_plan_exit away from a session whose whole point is the contract gate.
 */
function variantGatedEnv(
  bundles: readonly McpBundleName[], env: NodeJS.ProcessEnv,
): Record<string, string> {
  const childEnv = { ...builtinEnv(env), [MCP_BUNDLES_ENV]: encodeMcpBundles(bundles) };
  const variant = readPlanToolVariant(env);
  if (variant !== 'commission' || !bundles.includes('cortex-interaction-bridge')) return childEnv;
  const declared = parseMcpToolAllowlist(env[MCP_TOOL_ALLOWLIST_ENV]);
  childEnv[MCP_TOOL_ALLOWLIST_ENV] = JSON.stringify(
    applyPlanToolVariant(declared ? [...declared] : undefined, variant, bundles),
  );
  return childEnv;
}

function bundledServerConfig(
  bundles: readonly McpBundleName[], env: NodeJS.ProcessEnv,
): McpServerConfig {
  return {
    name: 'core',
    type: 'stdio',
    command: 'node',
    args: [BUNDLED_SERVER_PATH],
    env: variantGatedEnv(bundles, env),
    cwd: process.cwd(),
  };
}

function createState(name: string, config: McpServerConfig): ServerState {
  return {
    name,
    config,
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
  const bundles = core?.config.type === 'stdio'
    ? parseMcpBundles(core.config.env[MCP_BUNDLES_ENV]) : [];
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

function pluginLoadResult(value: ReturnType<PluginConfigLoader>): PiPluginMcpConfigLoadResult {
  return Array.isArray(value) ? { servers: value, issues: [] } : value;
}

function readPluginConfig(
  configPath: string,
  loadPluginConfig: PluginConfigLoader,
  reportPluginIssue: (issue: PiPluginMcpConfigIssue) => void,
): PiPluginMcpConfigLoadResult | null {
  try {
    return pluginLoadResult(loadPluginConfig(configPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportPluginIssue({ path: configPath, message });
    return null;
  }
}

function appendPluginState(
  server: McpServerConfig,
  configPath: string,
  states: ServerState[],
  seen: Set<string>,
  reportPluginIssue: (issue: PiPluginMcpConfigIssue) => void,
): void {
  const stateName = pluginServerStateName(server.name);
  if (seen.has(stateName)) {
    reportPluginIssue({
      path: `${configPath}#mcpServers`,
      message: `Duplicate MCP server state name: ${stateName}`,
    });
    return;
  }
  seen.add(stateName);
  states.push(createState(stateName, server));
}

function loadPluginStates(
  env: NodeJS.ProcessEnv,
  loadPluginConfig: PluginConfigLoader,
  reportPluginIssue: (issue: PiPluginMcpConfigIssue) => void,
): ServerState[] {
  const configPath = env[PI_PLUGIN_MCP_CONFIG_ENV];
  if (!configPath) return [];
  const loaded = readPluginConfig(configPath, loadPluginConfig, reportPluginIssue);
  if (!loaded) return [];
  const states: ServerState[] = [];
  const seen = new Set<string>();
  loaded.issues.forEach(reportPluginIssue);
  const servers = loaded.servers.slice().sort((left, right) => left.name.localeCompare(right.name));
  for (const server of servers) {
    appendPluginState(server, configPath, states, seen, reportPluginIssue);
  }
  return states;
}

/** Build the server set before connecting any MCP transport. */
export function buildServerStates(
  env: NodeJS.ProcessEnv,
  options: BuildServerStatesOptions = {},
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
  const states = [createState('core', bundledServerConfig(bundles, env))];
  if (env.CORTEX_PI_SUBAGENT !== '1') {
    states.push(...loadPluginStates(
      env,
      options.loadPluginConfig ?? loadPiPluginMcpConfig,
      options.reportPluginIssue ?? (() => undefined),
    ));
  }
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
  return state.config.name === state.name ? toolName : pluginToolName(state.name, toolName);
}

export const createSameOriginFetch = createRedirectRejectingFetch;

export function createMcpTransport(
  config: McpServerConfig,
  constructors: McpTransportConstructors = DEFAULT_TRANSPORT_CONSTRUCTORS,
): Transport {
  if (config.type === 'stdio') {
    return constructors.stdio({
      command: config.command,
      args: [...config.args],
      env: { ...process.env, ...config.env },
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

async function spawnMcpClient(state: ServerState): Promise<McpClientHandle> {
  const transport = createMcpTransport(state.config);
  const client = new Client({ name: `pi-mcp-bridge-${state.name}`, version: '1.0.0' });
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    try { await transport.close(); } catch { /* best-effort */ }
    throw error;
  }
}

const DEFAULT_DEPS: McpBridgeDeps = {
  env: process.env,
  spawnClient: spawnMcpClient,
  reportFailure: reportBridgeFailure,
  loadPluginConfig: loadPiPluginMcpConfig,
};

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
    this.states = buildServerStates(this.deps.env, {
      loadPluginConfig: this.deps.loadPluginConfig,
      reportPluginIssue: (issue) => this.deps.reportFailure(new Error(issue.message)),
    });
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
        return { content };
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

export async function installMcpBridge(
  pi: ExtensionAPI,
  deps: McpBridgeDeps = DEFAULT_DEPS,
): Promise<void> {
  new McpBridgeSession(pi, deps).install();
}

export default async function mcpBridge(pi: ExtensionAPI): Promise<void> {
  await installMcpBridge(pi);
}
