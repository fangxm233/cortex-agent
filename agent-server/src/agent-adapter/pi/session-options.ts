// input:  AgentSpawnConfig, resolved agent/session dirs, transcript path
// output: PiSessionRequest (everything an in-process PI session is created from) and its identity
// pos:    Resolves Cortex spawn configuration into PI session inputs
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { resolveMcpComposition } from '../types.js';
import type { AgentSpawnConfig, McpComposition, McpServerConfig } from '../types.js';
import { fromCanonical } from '../normalize/tool-names.js';
import { browserMcpServer } from '../browser-mcp-server.js';
import { buildPiEnv } from './spawn-args.js';

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
function allowedToolLabels(config: AgentSpawnConfig): string | undefined {
  const canonical = config.tools && config.tools.length > 0
    ? config.tools.map((tool) => fromCanonical('claude', tool))
      .filter((name): name is string => !!name).join(',')
    : undefined;
  return config.rawTools ?? canonical;
}

function subagentMarker(config: AgentSpawnConfig): string | undefined {
  return config.env?.CORTEX_PI_SUBAGENT === '1' ? '1' : undefined;
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
  config: AgentSpawnConfig,
  composition: McpComposition,
  marker: string | undefined,
): McpServerConfig[] {
  if (!allowsPluginMcp(composition, marker)) return [];
  const servers = [...(config.mcpServers ?? [])];
  if (config.browserCdpEndpoint && composition === 'direct') {
    servers.push(browserMcpServer(config.browserCdpEndpoint));
  }
  return servers;
}

/** Thinking level: the profile field wins unless `extraOption` carries an explicit `--thinking`. */
function thinkingLevel(config: AgentSpawnConfig): string | null {
  const explicit = config.extraOption?.['--thinking'];
  return explicit || config.thinking || null;
}

/** `extraOption` keys other than `--thinking` were PI CLI flags; there is no CLI to hand them to. */
export function unsupportedExtraOptions(config: AgentSpawnConfig): string[] {
  return Object.keys(config.extraOption ?? {}).filter((key) => key !== '--thinking');
}

export function buildSessionRequest(
  config: AgentSpawnConfig,
  inputs: SessionRequestInputs,
): PiSessionRequest {
  const composition = resolveMcpComposition(config.mcpComposition, config.cortexContext?.useCoreMcp);
  const marker = subagentMarker(config);
  const env = buildPiEnv({
    sessionId: config.sessionId,
    channel: config.channel,
    callbackSource: config.callbackSource,
    scheduleTaskId: config.scheduleTaskId,
    extraEnv: config.env,
    unsetEnv: config.unsetEnv,
    context: config.cortexContext,
    piAgentDir: inputs.agentDir,
    allowedTools: allowedToolLabels(config),
    mcpComposition: composition,
    mcpToolAllowlist: config.mcpToolAllowlist,
    enableInteractionBridge: composition === 'direct'
      && config.isUserInitiated === true
      && marker === undefined,
    commissionTools: config.commissionTools === true,
    subagentMarker: marker,
  }, config.pinnedEnv);
  return {
    sessionKey: config.sessionKey,
    cwd: inputs.cwd,
    agentDir: inputs.agentDir,
    sessionDir: inputs.sessionDir,
    sessionPath: inputs.sessionPath,
    provider: config.piProvider ?? null,
    model: config.model ? stripModelSuffix(config.model) : null,
    thinking: thinkingLevel(config),
    systemPrompt: config.systemPrompt || null,
    appendSystemPrompt: promptValues(config.appendSystemPrompt),
    skillPaths: [...(config.pluginSkillDirs ?? []), ...(config.pluginDirs ?? [])],
    disableHooks: config.disableHooks === true,
    reportsProviderQuota: !!config.piGatewayBaseUrl,
    pluginMcpServers: pluginMcpServers(config, composition, marker),
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
