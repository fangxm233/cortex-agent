// input:  run options, agent config, mode route, settings
// output: EngineSpec and engine identity
// pos:    Run-layer engine spec builder — P2.1a
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { getSettings } from '@core/settings.js';
import { canonicalizeMcpToolAllowlist } from '@core/mcp-tool-gate.js';
import type {
  AgentProcessSpawner, EngineSpec, CortexContextEnv, McpComposition,
} from '../../agent-adapter/types.js';
import { resolveMcpComposition } from '../../agent-adapter/types.js';
import { GATEWAY_URL } from '../costs/gateway-manager.js';
import { loadCortexRules } from '../memory/rules-loader.js';
import { resolvePluginRuntime } from '../plugins/runtime.js';
import type { ModeEnv } from '../agents/config.js';
import type { AgentConfig, RunAgentOptions } from '../agents/spawn-config.js';

// --- Types ---

/** Session scope and current policy evaluated at spawn time, after agent assignment. */
export interface PluginScope {
  channel?: string;
  feishuSkillsInWeb?: boolean;
  /** True while the session is in commission mode, drafting or already bound. */
  commissionMode?: boolean;
}

// --- Scoped plugin gating ---

/** Default channel scopes. The Feishu skill bundle also permits web: sessions when
 * feishuSkillsInWeb is enabled; MCP channel rules are separate and unchanged. */
export const CHANNEL_SCOPED_PLUGINS: ReadonlyArray<{ plugin: string; channelPrefix: string }> = [
  { plugin: 'cortex-feishu', channelPrefix: 'feishu:' },
];

/** Plugins that load only for sessions in commission mode. The commission skill is long and
 *  prescriptive (drill protocol, contract shape, checkpoint discipline); loading it into every
 *  session would put a procedure nobody asked for in front of the model (DR-0037 v2). */
export const COMMISSION_SCOPED_PLUGINS: readonly string[] = ['cortex-commission'];

/** Drop scoped plugin dirs the current session does not qualify for. Non-scoped plugins always pass
 *  through. Matched by the plugin dir's final path segment (basename) so substrings like
 *  `cortex-feishu-x` are not affected. */
export function filterScopedPlugins(
  dirs: string[] | undefined,
  scope: PluginScope,
): string[] | undefined {
  if (!dirs) return dirs;
  if (!Array.isArray(dirs)) return undefined;
  return dirs.filter((dir) => {
    if (typeof dir !== 'string') return false;
    const base = dir.split('/').filter(Boolean).pop() ?? '';
    if (COMMISSION_SCOPED_PLUGINS.includes(base)) return scope.commissionMode === true;
    const rule = CHANNEL_SCOPED_PLUGINS.find((r) => r.plugin === base);
    if (!rule) return true;
    const webFeishu = base === 'cortex-feishu' && scope.feishuSkillsInWeb === true && scope.channel?.startsWith('web:');
    return !!webFeishu || !!scope.channel?.startsWith(rule.channelPrefix);
  });
}

/** @deprecated Kept for callers that only gate on the channel; prefer {@link filterScopedPlugins}. */
export function filterChannelScopedPlugins(
  dirs: string[] | undefined,
  channel: string | undefined,
): string[] | undefined {
  return filterScopedPlugins(dirs, { channel, commissionMode: false });
}

// --- PI gateway routing ---

/**
 * Build the gateway sub-path for a PI provider's models.json override, following the gateway's URL
 * convention `/m/<mode>/<endpoint>`. The `mode` selects the gateway route (gateway.yaml owns the
 * upstream + keys); the `provider` is both the PI `--provider` and the gateway endpoint segment.
 *
 * `provider` is required for pi profiles (validated at load time — no default, no fallback). Returns
 * undefined when `mode` is absent — the PI adapter then falls back to the default `/<provider>` path
 * (direct per-provider routing, no `/m/` mode indirection).
 *
 * Keeping this derivation in code (not in the profile) means profiles only carry the logical
 * `mode` name; no gateway path string leaks into profiles.json.
 */
export function buildPiGatewaySubPath(mode: string | null, provider: string): string | undefined {
  if (!mode) return undefined;
  return `/m/${mode}/${provider}`;
}

// --- Spec helpers ---

function spawnContext(options: RunAgentOptions): CortexContextEnv {
  return {
    threadId: options.threadId ?? null,
    profile: options.profileName ?? null,
    project: options.project ?? null,
    sessionName: options.sessionName ?? null,
    trackSessionId: options.trackSessionId ?? options.sessionId ?? null,
    executionId: options.executionId ?? null,
    useCoreMcp: options.useCoreMcp ?? undefined,
    threadDepth: options.threadDepth ?? null,
    taskId: options.taskId ?? null,
    taskProject: options.taskProject ?? null,
    taskGeneration: options.taskGeneration ?? null,
  };
}

function hasSpawnContext(context: CortexContextEnv): boolean {
  return Object.entries(context).some(([key, value]) => {
    return key === 'threadDepth' ? value != null : Boolean(value);
  });
}

/** Everything appended to the backend's own system prompt: the ambient global rules, then the
 *  caller's own text. A subagent role reaches its child through the second half — with
 *  `loadCortexRules: false` the role body is all the child sees. */
function rulesPrompt(options: RunAgentOptions): string | undefined {
  const rules = options.loadCortexRules === false ? [] : loadCortexRules().global;
  const parts = rules.map(rule => rule.body);
  const extra = options.appendSystemPrompt?.trim();
  if (extra) parts.push(extra);
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

function canonicalToolList(options: RunAgentOptions): string[] | undefined {
  return Array.isArray(options.tools) ? options.tools : undefined;
}

function rawClaudeTools(options: RunAgentOptions): string | undefined {
  return typeof options.tools === 'string' ? options.tools : undefined;
}

function spawnPolicy(options: RunAgentOptions): Pick<EngineSpec, 'flags' | 'process' | 'mcp'> {
  return {
    mcp: {
      composition: undefined,
      servers: undefined,
      allowlist: options.mcpToolAllowlist === undefined
        ? undefined : canonicalizeMcpToolAllowlist(options.mcpToolAllowlist),
      configPaths: options.mcpConfigPaths,
      commissionTools: options.commissionTools,
      browserCdpEndpoint: options.browserCdpEndpoint ?? undefined,
    },
    flags: {
      disableHooks: options.disableHooks,
      streamDeltas: options.streamDeltas,
      captureTranscripts: options.captureTranscriptLogs,
      preserveUnreportedAccounting: options.preserveUnreportedAccounting,
      isUserInitiated: !!options.isUserInitiated,
    },
    process: {
      spawner: options.processSpawner,
      cliPath: typeof options.cliPath === 'string' ? options.cliPath : undefined,
    },
  };
}

function pluginFields(
  options: RunAgentOptions,
  config: AgentConfig,
  mcpComposition: McpComposition,
): Pick<EngineSpec['plugins'], 'dirs' | 'skillDirs' | 'fingerprint'> & Pick<EngineSpec['mcp'], 'servers'> {
  const selectedPluginDirs = filterScopedPlugins(options.pluginDirs, {
    channel: options.channel,
    commissionMode: options.commissionMode,
    feishuSkillsInWeb: getSettings().feishuSkillsInWeb,
  });
  const runtime = resolvePluginRuntime({
    backend: config.backend, selectedPluginDirs, mcpComposition,
  });
  return {
    dirs: runtime.pluginDirs,
    skillDirs: runtime.pluginSkillDirs,
    servers: runtime.mcpServers,
    fingerprint: runtime.pluginCapabilityFingerprint,
  };
}

/** The credentials a mode route decides. ANTHROPIC_BASE_URL is deliberately absent: it travels on
 *  the dedicated `anthropicBaseUrl` spawn field, and writing it into `env` as well would give
 *  production-attempt-identity two sources for the attested route host — a drift source. */
const ROUTE_CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

function routeEnvSets(route: ModeEnv): Record<string, string> {
  const sets: Record<string, string> = {};
  for (const key of ROUTE_CREDENTIAL_KEYS) {
    const value = route[key];
    if (typeof value === 'string') sets[key] = value;
  }
  return sets;
}

/** A route fully decides the base URL, so an absent one means "delete": otherwise this spawn
 *  inherits whatever mode configured the daemon last. A key the profile set explicitly is never
 *  deleted — profile configuration outranks the mode's delete intent. */
function routeEnvDeletes(route: ModeEnv, extraEnv?: Record<string, string>): string[] {
  const deletes: string[] = ROUTE_CREDENTIAL_KEYS.filter(key => route[key] === null);
  if (!route.ANTHROPIC_BASE_URL) deletes.push('ANTHROPIC_BASE_URL');
  return deletes.filter(key => !extraEnv || !(key in extraEnv));
}

/** Per-spawn env: the route's sets first, then the profile's extraEnv (last-wins), then the
 *  route's deletes. An absent route states no routing opinion and touches neither channel. */
function routeEnvFields(
  route: ModeEnv | undefined,
  extraEnv?: Record<string, string>,
): { sets?: Record<string, string>; unsets?: string[] } {
  const sets = { ...(route ? routeEnvSets(route) : {}), ...extraEnv };
  const unsets = route ? routeEnvDeletes(route, extraEnv) : [];
  return {
    sets: Object.keys(sets).length > 0 ? sets : undefined,
    unsets: unsets.length > 0 ? unsets : undefined,
  };
}

function backendField(
  options: RunAgentOptions,
  config: AgentConfig,
): EngineSpec['backend'] {
  const claudeFields = {
    claudeAgent: options.claudeAgent ?? undefined,
    outputStyle: typeof options.outputStyle === 'string' ? options.outputStyle : undefined,
    claudeBackend: config.claudeBackend,
  };
  return config.backend === 'claude'
    ? { kind: 'claude', ...claudeFields }
    : { kind: 'pi' };
}

// --- Public API ---

/**
 * Group the resolved inputs into the backend-neutral {@link EngineSpec}.
 * Pure re-grouping: every value, condition and defaulting rule is the original flat builder's.
 */
export function buildEngineSpec(
  options: RunAgentOptions,
  config: AgentConfig,
  route: ModeEnv | undefined,
): EngineSpec {
  const mcpComposition = resolveMcpComposition(options.mcpComposition, options.useCoreMcp);
  const context = spawnContext(options);
  const appendSystemPrompt = rulesPrompt(options);
  const plugins = pluginFields(options, config, mcpComposition);
  const policy = spawnPolicy(options);
  const routeEnv = routeEnvFields(route, config.extraEnv);
  const provider = config.backend === 'pi' ? config.provider || undefined : undefined;
  return {
    engineKey: options.sessionKey || options.channel || 'default',
    cwd: options.cwd,
    resume: {
      backendSessionId: options.sessionId ?? null,
      resume: !!options.sessionId,
    },
    model: {
      id: config.model,
      provider,
      thinking: config.thinking || undefined,
      maxOutputTokens: config.backend === 'pi' ? config.maxOutputTokens ?? undefined : undefined,
    },
    prompt: {
      system: typeof options.systemPrompt === 'string' ? options.systemPrompt : undefined,
      append: appendSystemPrompt,
    },
    tools: {
      canonical: canonicalToolList(options),
      rawClaude: rawClaudeTools(options),
    },
    plugins: {
      dirs: plugins.dirs,
      skillDirs: plugins.skillDirs,
      fingerprint: plugins.fingerprint,
    },
    mcp: {
      ...policy.mcp,
      composition: mcpComposition,
      servers: plugins.servers,
    },
    env: {
      sets: routeEnv.sets,
      unsets: routeEnv.unsets,
      pinned: options.pinnedEnv,
      context: hasSpawnContext(context) ? context : undefined,
    },
    route: {
      anthropicBaseUrl: route?.ANTHROPIC_BASE_URL,
      gatewayBaseUrl: config.backend === 'pi' ? GATEWAY_URL : undefined,
      gatewayPath: provider ? buildPiGatewaySubPath(config.mode, provider) : undefined,
    },
    flags: policy.flags,
    context: {
      channel: options.channel,
      callbackSource: options.callbackSource ?? undefined,
      scheduleTaskId: options.scheduleTaskId ?? undefined,
    },
    extraOption: config.extraOption && Object.keys(config.extraOption).length > 0
      ? config.extraOption : undefined,
    backend: backendField(options, config),
    process: policy.process,
  };
}

/**
 * A stable string for "would this spec reuse the same engine": canonical JSON with sorted keys,
 * excluding `resume`, `env.context.executionId`, and `process.spawner`.
 */
export function engineIdentity(spec: EngineSpec): string {
  const { resume: _resume, ...rest } = spec;
  const context = spec.env.context
    ? Object.fromEntries(
        Object.entries(spec.env.context).filter(([key]) => key !== 'executionId'),
      ) as CortexContextEnv
    : undefined;
  const projected = {
    ...rest,
    env: { ...spec.env, context },
    process: { ...spec.process, spawner: undefined as AgentProcessSpawner | undefined },
  };
  return JSON.stringify(canonicalize(projected));
}

/** Recursively sort object keys and drop `undefined` so identity is independent of construction order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}
