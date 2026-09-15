import { getSettings } from '@core/settings.js';
import { canonicalizeMcpToolAllowlist } from '@core/mcp-tool-gate.js';
import type {
  AgentProcessSpawner, EngineSpec, CortexContextEnv, McpComposition,
} from '../../agent-adapter/types.js';
import { resolveMcpComposition } from '../../agent-adapter/types.js';
import { GATEWAY_URL } from '../costs/gateway-manager.js';
import { composeSystemPrompt, globalRuleBodies } from './prompt.js';
import { resolvePluginRuntime } from '../plugins/runtime.js';
import type { ModeEnv } from '../agents/config.js';
import type { RunAttemptConfig } from '../agents/profile-manager.js';
import type { RunRequest } from './request.js';

// --- Types ---

/** Session scope and current policy evaluated at spawn time, after agent assignment. */
export interface PluginScope {
  channel?: string;
  feishuSkillsInWeb?: boolean;
  /** True once the session is BOUND to a landed commission. Drafting deliberately does not count
   *  (DR-0037 v4): the creation protocol lives in `cortex_commission_start`'s return value, and the
   *  skill covers maintenance only — it says so itself. Loading it during the drill would put the
   *  wrong half of the procedure in front of the model. */
  commissionMode?: boolean;
}

// --- Scoped plugin gating ---

/** Default channel scopes. The Feishu skill bundle also permits web: sessions when
 * feishuSkillsInWeb is enabled; MCP channel rules are separate and unchanged. */
export const CHANNEL_SCOPED_PLUGINS: ReadonlyArray<{ plugin: string; channelPrefix: string }> = [
  { plugin: 'cortex-feishu', channelPrefix: 'feishu:' },
];

/** Plugins that load only for sessions BOUND to a commission. The commission skill is long and
 *  prescriptive (ledger entries, surprise triage, checkpoint discipline); loading it into every
 *  session would put a procedure nobody asked for in front of the model (DR-0037 v2).
 *
 *  Plugin dirs are part of the pool identity, so a contract landing mid-session brings the skill in
 *  on the next turn via a fresh spawn + `--resume`. The turn the contract lands on is covered by
 *  the protocol `cortex_commission_submit` returns on approval. */
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

function spawnContext(request: RunRequest, executionId: string | null): CortexContextEnv {
  return {
    threadId: request.context.threadId ?? null,
    // `|| null`, not `?? null`: a synthesized profile (a subagent child, a fixture) carries an
    // empty name because it was never looked up by name, and the child env must stay as it was
    // before the run model — CORTEX_PROFILE absent, not set to an invented profile name.
    profile: request.profile.name || null,
    project: request.context.project ?? null,
    sessionName: request.session.sessionName ?? null,
    trackSessionId: request.session.sessionId ?? request.session.backendSessionId ?? null,
    executionId: executionId ?? null,
    useCoreMcp: request.policy.useCoreMcp ?? undefined,
    threadDepth: request.context.threadDepth ?? null,
    taskId: request.context.taskId ?? null,
    taskProject: request.context.taskProject ?? null,
    taskGeneration: request.context.taskGeneration ?? null,
  };
}

function hasSpawnContext(context: CortexContextEnv): boolean {
  return Object.entries(context).some(([key, value]) => {
    return key === 'threadDepth' ? value != null : Boolean(value);
  });
}

/** A spec's tool surface is either a canonical list or Claude's raw `--tools` string. */
function canonicalToolList(request: RunRequest): string[] | undefined {
  return Array.isArray(request.spec.tools) ? request.spec.tools : undefined;
}

function rawClaudeTools(request: RunRequest): string | undefined {
  return typeof request.spec.tools === 'string' ? request.spec.tools : undefined;
}

function spawnPolicy(request: RunRequest): Pick<EngineSpec, 'flags' | 'process' | 'mcp'> {
  return {
    mcp: {
      composition: undefined,
      servers: undefined,
      allowlist: request.policy.mcpToolAllowlist === undefined
        ? undefined : canonicalizeMcpToolAllowlist(request.policy.mcpToolAllowlist),
      configPaths: request.isolation?.mcpConfigPaths,
      browserCdpEndpoint: request.policy.browserCdpEndpoint ?? undefined,
    },
    flags: {
      // The request states what the run WANTS; the spec states what the engine is TOLD. `hooks`
      // and `disableHooks` are the same fact with opposite polarity, and `undefined` must survive
      // as `undefined` so an unset policy keeps the adapter's own default.
      disableHooks: request.policy.hooks === undefined ? undefined : !request.policy.hooks,
      streamDeltas: request.policy.streamDeltas,
      captureTranscripts: request.policy.captureTranscripts,
      preserveUnreportedAccounting: request.benchmark?.preserveUnreportedAccounting,
      isUserInitiated: !!request.context.isUserInitiated,
    },
    process: {
      spawner: request.isolation?.spawner,
      cliPath: typeof request.isolation?.cliPath === 'string' ? request.isolation.cliPath : undefined,
    },
  };
}

function pluginFields(
  request: RunRequest,
  attempt: RunAttemptConfig,
  mcpComposition: McpComposition,
): Pick<EngineSpec['plugins'], 'dirs' | 'skillDirs' | 'fingerprint'> & Pick<EngineSpec['mcp'], 'servers'> {
  const selectedPluginDirs = filterScopedPlugins(request.spec.pluginDirs, {
    channel: request.context.channel,
    commissionMode: request.context.commissionMode,
    feishuSkillsInWeb: getSettings().feishuSkillsInWeb,
  });
  const runtime = resolvePluginRuntime({
    backend: attempt.backend, selectedPluginDirs, mcpComposition,
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
  request: RunRequest,
  attempt: RunAttemptConfig,
): EngineSpec['backend'] {
  const claudeFields = {
    claudeAgent: request.spec.backendOptions.claudeAgent ?? undefined,
    outputStyle: typeof request.spec.backendOptions.outputStyle === 'string'
      ? request.spec.backendOptions.outputStyle : undefined,
    claudeBackend: attempt.claudeBackend,
  };
  return attempt.backend === 'claude'
    ? { kind: 'claude', ...claudeFields }
    : { kind: 'pi' };
}

// --- Public API ---

/**
 * Group the resolved inputs into the backend-neutral {@link EngineSpec}.
 * Pure re-grouping: every value, condition and defaulting rule is the original flat builder's.
 */
export function buildEngineSpec(
  request: RunRequest,
  attempt: RunAttemptConfig,
  opts: { route?: ModeEnv; executionId?: string | null } = {},
): EngineSpec {
  const { route, executionId = null } = opts;
  const mcpComposition = resolveMcpComposition(request.policy.mcpComposition, request.policy.useCoreMcp);
  const context = spawnContext(request, executionId);
  const appendSystemPrompt = composeSystemPrompt(request.spec, {
    rules: globalRuleBodies(request.policy.loadRules !== false),
  });
  const plugins = pluginFields(request, attempt, mcpComposition);
  const policy = spawnPolicy(request);
  const routeEnv = routeEnvFields(route, attempt.extraEnv);
  const provider = attempt.backend === 'pi' ? attempt.provider || undefined : undefined;
  return {
    engineKey: request.session.engineKey || request.context.channel || 'default',
    cwd: request.cwd ?? undefined,
    resume: {
      backendSessionId: request.session.backendSessionId ?? null,
      resume: !!request.session.backendSessionId,
    },
    model: {
      id: attempt.model,
      provider,
      thinking: attempt.thinking || undefined,
      maxOutputTokens: attempt.backend === 'pi' ? attempt.maxOutputTokens ?? undefined : undefined,
    },
    prompt: {
      system: typeof request.spec.systemPrompt === 'string' ? request.spec.systemPrompt : undefined,
      append: appendSystemPrompt,
    },
    tools: {
      canonical: canonicalToolList(request),
      rawClaude: rawClaudeTools(request),
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
      pinned: request.isolation?.pinnedEnv,
      context: hasSpawnContext(context) ? context : undefined,
    },
    route: {
      anthropicBaseUrl: route?.ANTHROPIC_BASE_URL,
      gatewayBaseUrl: attempt.backend === 'pi' ? GATEWAY_URL : undefined,
      gatewayPath: provider ? buildPiGatewaySubPath(attempt.mode, provider) : undefined,
    },
    flags: policy.flags,
    context: {
      channel: request.context.channel,
      callbackSource: request.context.callbackSource ?? undefined,
      scheduleTaskId: request.context.scheduleTaskId ?? undefined,
    },
    extraOption: attempt.extraOption && Object.keys(attempt.extraOption).length > 0
      ? attempt.extraOption : undefined,
    backend: backendField(request, attempt),
    process: policy.process,
  };
}

/**
 * A stable string for "would this spec reuse the same engine": canonical JSON with sorted keys,
 * excluding `resume`, `env.context.executionId`, and `process.spawner`.
 *
 * NOT the pool's reuse test, despite D3 proposing it as one. `SessionEngines.acquire` calls the
 * BACKEND's `specIdentity` (`pi.specIdentity` / `claude.specIdentity`) instead, because each covers
 * the resolved env, MCP composition and argv that this generic form cannot see — a spec pair that
 * looks identical here can still need different processes. Kept and tested as the neutral
 * definition; do not "fix" the pool to call it without first widening it.
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
