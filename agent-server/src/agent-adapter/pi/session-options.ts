import { resolveMcpComposition } from '../types.js';
import type { CortexContextEnv, EngineSpec, McpComposition, McpServerConfig } from '../types.js';
import { fromCanonical } from '@core/tool-names.js';
import { browserMcpServer } from '../browser-mcp-server.js';
import { MCP_TOOL_ALLOWLIST_ENV } from '@core/mcp-tool-gate.js';

export const PI_MCP_COMPOSITION_ENV = 'CORTEX_PI_MCP_COMPOSITION';
export const PI_INTERACTION_BRIDGE_ENV = 'CORTEX_PI_INTERACTION_BRIDGE';
/** Set while a NEW commission is being drafted. Read by the MCP bridge, which is where PI knows its
 *  bundle set and can therefore write the allowlist that hides the commission tools from every other
 *  session. */
export const PI_COMMISSION_TOOLS_ENV = 'CORTEX_PI_COMMISSION_TOOLS';

export interface PIEnvOptions {
  sessionId?: string | null;
  channel?: string | null;
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  extraEnv?: Record<string, string> | null;
  /** Keys deleted after the `extraEnv` merge (EngineSpec.env.unsets). PI routes purely through
   *  env, so this is how a mode expresses "this spawn must not carry ANTHROPIC_API_KEY". */
  unsetEnv?: string[] | null;
  context?: CortexContextEnv;
  piAgentDir: string;
  allowedTools?: string | null;
  /** Resolved MCP composition; the bridge derives its server set from it. */
  mcpComposition?: McpComposition;
  /** Canonical per-tool MCP allowlist inherited by built-in stdio servers. */
  mcpToolAllowlist?: string[] | null;
  /** Trusted marker enabling the shared interaction MCP bridge. */
  enableInteractionBridge?: boolean;
  /** Expose the commission-creation tools; ignored when the bridge is off. */
  commissionTools?: boolean;
  /** Explicit marker for the restricted PI subagent surface. */
  subagentMarker?: string | null;
}

const RESET_CONTEXT_KEYS = [
  'SLACK_CHANNEL', 'FEISHU_CHANNEL',
  'CORTEX_SESSION_ID', 'CORTEX_THREAD_ID', 'CORTEX_PROFILE',
  'CORTEX_PROJECT', 'CORTEX_SESSION_NAME', 'CORTEX_EXECUTION_ID',
  'CORTEX_THREAD_DEPTH', 'CORTEX_TASK_ID', 'CORTEX_TASK_PROJECT',
  'CORTEX_TASK_GENERATION',
  'CORTEX_CALLBACK_SOURCE', 'CORTEX_SCHEDULE_TASK_ID',
  'CORTEX_CONFIG_IMMUTABLE', 'CORTEX_PRODUCTION_AUTH_FILE',
  'CORTEX_WEBHOOK_THREAD_OP_ONLY', 'CORTEX_WEBHOOK_SINGLE_ROOT',
  'CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE',
  'CORTEX_PRODUCTION_BENCHMARK_EVIDENCE_CONTEXT_FILE',
  'CORTEX_PI_ALLOWED_TOOLS', 'CORTEX_PI_SUBAGENT',
  PI_MCP_COMPOSITION_ENV, PI_INTERACTION_BRIDGE_ENV, PI_COMMISSION_TOOLS_ENV,
  MCP_TOOL_ALLOWLIST_ENV,
] as const;

function setOptional(env: NodeJS.ProcessEnv, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') env[key] = String(value);
}

function applyContext(env: NodeJS.ProcessEnv, options: PIEnvOptions): void {
  const context = options.context;
  setOptional(env, 'CORTEX_SESSION_ID', context?.trackSessionId ?? options.sessionId);
  setOptional(env, 'CORTEX_CALLBACK_SOURCE', options.callbackSource);
  setOptional(env, 'CORTEX_SCHEDULE_TASK_ID', options.scheduleTaskId);
  setOptional(env, 'CORTEX_THREAD_ID', context?.threadId);
  setOptional(env, 'CORTEX_PROFILE', context?.profile);
  setOptional(env, 'CORTEX_PROJECT', context?.project);
  setOptional(env, 'CORTEX_SESSION_NAME', context?.sessionName);
  setOptional(env, 'CORTEX_EXECUTION_ID', context?.executionId);
  setOptional(env, 'CORTEX_THREAD_DEPTH', context?.threadDepth);
  setOptional(env, 'CORTEX_TASK_ID', context?.taskId);
  setOptional(env, 'CORTEX_TASK_PROJECT', context?.taskProject);
  setOptional(env, 'CORTEX_TASK_GENERATION', context?.taskGeneration);
}

/**
 * The session's CORTEX_* environment: the inherited env with every Cortex scope key reset, then
 * this spawn's own scope applied. The hook scripts and plugin MCP servers a session still forks
 * read their scope from it, and it doubles as part of the pooled-session identity.
 */
export function buildPiEnv(
  options: PIEnvOptions,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inheritedEnv, ...(options.extraEnv ?? {}) };
  for (const key of RESET_CONTEXT_KEYS) delete env[key];
  // After the merge: deletion is the only way to express "absent", since '' is a legal value here.
  for (const key of options.unsetEnv ?? []) delete env[key];
  env.PI_CODING_AGENT_DIR = options.piAgentDir;
  env.CORTEX_BACKEND = 'pi';
  if (options.channel) {
    env.SLACK_CHANNEL = options.channel;
    env.FEISHU_CHANNEL = options.channel;
  }
  setOptional(env, 'CORTEX_PI_ALLOWED_TOOLS', options.allowedTools);
  setOptional(env, PI_MCP_COMPOSITION_ENV, options.mcpComposition);
  if (options.mcpToolAllowlist !== undefined && options.mcpToolAllowlist !== null) {
    env[MCP_TOOL_ALLOWLIST_ENV] = JSON.stringify(options.mcpToolAllowlist);
  }
  if (options.enableInteractionBridge === true) env[PI_INTERACTION_BRIDGE_ENV] = '1';
  if (options.commissionTools === true) env[PI_COMMISSION_TOOLS_ENV] = '1';
  setOptional(env, 'CORTEX_PI_SUBAGENT', options.subagentMarker);
  applyContext(env, options);
  return env;
}

/** Everything one in-process PI session is built from. Plain data so it can be compared. */
export interface PiSessionRequest {
  sessionKey: string;
  cwd: string;
  /** PI agent dir holding auth.json and the gateway-routed models.json. */
  agentDir: string;
  sessionDir: string;
  /** Existing transcript to resume, or null to start a new one. Not part of the identity. */
  sessionPath: string | null;
  provider: string | null;
  /** Model id with any context-window suffix (`[1m]`) stripped. */
  model: string | null;
  thinking: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string[];
  /** Skill roots passed to PI (portable plugin skills first, then legacy plugin dirs). */
  skillPaths: string[];
  disableHooks: boolean;
  /** Gateway-routed runs report provider quota read off response headers. */
  reportsProviderQuota: boolean;
  /** Plugin/browser MCP servers, already filtered by composition. Empty when none apply. */
  pluginMcpServers: McpServerConfig[];
  /**
   * The session's CORTEX_* environment. Nothing in-process reads scope from it; it exists for the
   * two things that are still child processes (hook scripts, plugin MCP servers), for the child
   * subagent of the transition period, and as the pool identity.
   */
  env: NodeJS.ProcessEnv;
  streamDeltas: boolean;
}

export interface SessionRequestInputs {
  agentDir: string;
  sessionDir: string;
  sessionPath: string | null;
  cwd: string;
  streamDeltas: boolean;
}

/** Strip a context-window suffix like "[1m]" (e.g. "deepseek-v4-flash[1m]" → "deepseek-v4-flash"). */
export function stripModelSuffix(model: string): string {
  return model.replace(/\[.*?\]$/, '');
}

function promptValues(value: string | string[] | undefined | null): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry.length > 0);
}

/** Claude-native labels of the allowed tools, the form the tool shims gate on. */
function allowedToolLabels(spec: EngineSpec): string | undefined {
  const canonical = spec.tools.canonical && spec.tools.canonical.length > 0
    ? spec.tools.canonical.map((tool) => fromCanonical('claude', tool))
      .filter((name): name is string => !!name).join(',')
    : undefined;
  return spec.tools.rawClaude ?? canonical;
}

function subagentMarker(spec: EngineSpec): string | undefined {
  return spec.env.sets?.CORTEX_PI_SUBAGENT === '1' ? '1' : undefined;
}

function allowsPluginMcp(composition: McpComposition, marker: string | undefined): boolean {
  if (composition === 'direct') return true;
  return composition === 'thread-control' && marker === undefined;
}

/**
 * Plugin MCP servers for this session. Browser control rides along like any other plugin server,
 * gated on `direct` for the same reason Claude gates it: an unattended worker sharing one browser
 * is a cross-run side channel, not a feature.
 */
export function pluginMcpServers(
  spec: EngineSpec,
  composition: McpComposition,
  marker: string | undefined,
): McpServerConfig[] {
  if (!allowsPluginMcp(composition, marker)) return [];
  const servers = [...(spec.mcp.servers ?? [])];
  if (spec.mcp.browserCdpEndpoint && composition === 'direct') {
    servers.push(browserMcpServer(spec.mcp.browserCdpEndpoint));
  }
  return servers;
}

/** Thinking level: the profile field wins unless `extraOption` carries an explicit `--thinking`. */
function thinkingLevel(spec: EngineSpec): string | null {
  const explicit = spec.extraOption?.['--thinking'];
  return explicit || spec.model.thinking || null;
}

/** `extraOption` keys other than `--thinking` were PI CLI flags; there is no CLI to hand them to. */
export function unsupportedExtraOptions(spec: EngineSpec): string[] {
  return Object.keys(spec.extraOption ?? {}).filter((key) => key !== '--thinking');
}

export function buildSessionRequest(
  spec: EngineSpec,
  inputs: SessionRequestInputs,
): PiSessionRequest {
  const composition = resolveMcpComposition(spec.mcp.composition, spec.env.context?.useCoreMcp);
  const marker = subagentMarker(spec);
  const env = buildPiEnv({
    sessionId: spec.resume.backendSessionId,
    channel: spec.context.channel,
    callbackSource: spec.context.callbackSource,
    scheduleTaskId: spec.context.scheduleTaskId,
    extraEnv: spec.env.sets,
    unsetEnv: spec.env.unsets,
    context: spec.env.context,
    piAgentDir: inputs.agentDir,
    allowedTools: allowedToolLabels(spec),
    mcpComposition: composition,
    mcpToolAllowlist: spec.mcp.allowlist,
    enableInteractionBridge: composition === 'direct'
      && spec.flags.isUserInitiated === true
      && marker === undefined,
    commissionTools: spec.mcp.commissionTools === true,
    subagentMarker: marker,
  }, spec.env.pinned);
  return {
    sessionKey: spec.engineKey,
    cwd: inputs.cwd,
    agentDir: inputs.agentDir,
    sessionDir: inputs.sessionDir,
    sessionPath: inputs.sessionPath,
    provider: spec.model.provider ?? null,
    model: spec.model.id ? stripModelSuffix(spec.model.id) : null,
    thinking: thinkingLevel(spec),
    systemPrompt: spec.prompt.system || null,
    appendSystemPrompt: promptValues(spec.prompt.append),
    skillPaths: [...(spec.plugins.skillDirs ?? []), ...(spec.plugins.dirs ?? [])],
    disableHooks: spec.flags.disableHooks === true,
    reportsProviderQuota: !!spec.route.gatewayBaseUrl,
    pluginMcpServers: pluginMcpServers(spec, composition, marker),
    env,
    streamDeltas: inputs.streamDeltas,
  };
}

/**
 * Per-run env that must NOT force a new session. A pooled session keeps the value from the turn
 * that started it — the same spawn-time snapshot the Claude adapter documents for its own pooled
 * sessions. Making the execution id part of the identity would defeat pooling outright.
 */
const IDENTITY_EXEMPT_ENV = new Set(['CORTEX_EXECUTION_ID']);

/**
 * The exact configuration a live PI session was created with, as a comparable string. Everything
 * in the request is part of it except the transcript path (a live session can be re-pointed at
 * another transcript) and the per-run env keys above.
 */
export function sessionIdentity(request: PiSessionRequest): string {
  const { sessionPath: _sessionPath, env, ...rest } = request;
  const identityEnv = Object.entries(env)
    .filter(([key]) => !IDENTITY_EXEMPT_ENV.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify({ ...rest, env: identityEnv });
}
