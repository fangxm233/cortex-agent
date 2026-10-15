import { getSettings } from '@core/settings.js';
import { canonicalizeMcpToolAllowlist } from '@core/mcp-tool-gate.js';
import type {
  EngineSpec, CortexContextEnv, McpComposition,
} from '../../agent-adapter/types.js';
import { resolveMcpComposition } from '../../agent-adapter/types.js';
import { GATEWAY_URL } from '../costs/gateway-manager.js';
import { composeSystemPrompt, globalRuleBodies } from './prompt.js';
import { resolvePluginRuntime } from '../plugins/runtime.js';
import type { ModeEnv } from './mode-env.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import type { RunRequest } from './request.js';

// --- Types ---

/** Session scope and current policy evaluated at spawn time, after agent assignment. */
export interface PluginScope {
  channel?: string;
  feishuSkillsInWeb?: boolean;
}

// --- Scoped plugin gating ---

/** Default channel scopes. The Feishu skill bundle also permits web: sessions when
 * feishuSkillsInWeb is enabled; MCP channel rules are separate and unchanged. */
export const CHANNEL_SCOPED_PLUGINS: ReadonlyArray<{ plugin: string; channelPrefix: string }> = [
  { plugin: 'cortex-feishu', channelPrefix: 'feishu:' },
];

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
    const rule = CHANNEL_SCOPED_PLUGINS.find((r) => r.plugin === base);
    if (!rule) return true;
    const webFeishu = base === 'cortex-feishu' && scope.feishuSkillsInWeb === true && scope.channel?.startsWith('web:');
    return !!webFeishu || !!scope.channel?.startsWith(rule.channelPrefix);
  });
}

// --- PI gateway routing ---

/**
 * Build the gateway sub-path for a PI provider's models.json override, following the gateway's URL
 * convention `/m/<mode>/<endpoint>`. The `mode` selects the gateway route (gateway.yaml owns the
 * upstream + keys); the `provider` is both the PI `--provider` and the gateway endpoint segment.
 *
 * The selection carries a logical mode, not a gateway URL. An absent mode uses direct routing.
 */
export function buildPiGatewaySubPath(mode: string | null, provider: string): string | undefined {
  if (!mode) return undefined;
  return `/m/${mode}/${provider}`;
}

// --- Spec helpers ---

function spawnContext(
  request: RunRequest, attempt: EngineSelection, executionId: string | null,
): CortexContextEnv {
  return {
    selection: { ...attempt },
    project: request.context.project ?? null,
    trackSessionId: request.session.sessionId ?? request.session.backendSessionId ?? null,
    executionId: executionId ?? null,
  };
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
      // Same polarity rule for skills, and the same reason to keep `undefined` alive: only an
      // agent that opted out states anything here.
      disableSkills: request.policy.skills === false ? true : undefined,
      settingSources: request.policy.settingSources,
      streamDeltas: request.policy.streamDeltas,
      captureTranscripts: request.policy.captureTranscripts,
      isUserInitiated: !!request.context.isUserInitiated,
      ...(request.context.teamLead ? { teamLead: true } : {}),
      ...(request.context.teamWorker ? { teamWorker: true } : {}),
    },
    process: {
      spawner: request.isolation?.spawner,
      cliPath: typeof request.isolation?.cliPath === 'string' ? request.isolation.cliPath : undefined,
    },
  };
}

function pluginFields(
  request: RunRequest,
  attempt: EngineSelection,
  mcpComposition: McpComposition,
): EngineSpec['plugins'] & Pick<EngineSpec['mcp'], 'servers'> {
  const selectedPluginDirs = filterScopedPlugins(request.spec.pluginDirs, {
    channel: request.context.channel,
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
    ...(runtime.warnings ? { warnings: runtime.warnings } : {}),
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

/** An absent route base URL must not inherit a previous daemon route. */
function routeEnvDeletes(route: ModeEnv): string[] {
  const deletes: string[] = ROUTE_CREDENTIAL_KEYS.filter(key => route[key] === null);
  if (!route.ANTHROPIC_BASE_URL) deletes.push('ANTHROPIC_BASE_URL');
  return deletes;
}

/** Environment comes only from the resolved route, not user configuration. */
function routeEnvFields(
  route: ModeEnv | undefined,
): { sets?: Record<string, string>; unsets?: string[] } {
  const sets = route ? routeEnvSets(route) : {};
  const unsets = route ? routeEnvDeletes(route) : [];
  return {
    sets: Object.keys(sets).length > 0 ? sets : undefined,
    unsets: unsets.length > 0 ? unsets : undefined,
  };
}

function backendField(
  request: RunRequest,
  attempt: EngineSelection,
): EngineSpec['backend'] {
  const claudeFields = {
    claudeAgent: request.spec.backendOptions.claudeAgent ?? undefined,
    outputStyle: typeof request.spec.backendOptions.outputStyle === 'string'
      ? request.spec.backendOptions.outputStyle : undefined,
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
  attempt: EngineSelection,
  opts: { route?: ModeEnv; executionId?: string | null } = {},
): EngineSpec {
  const { route, executionId = null } = opts;
  const mcpComposition = resolveMcpComposition(request.policy.mcpComposition);
  const context = spawnContext(request, attempt, executionId);
  const appendSystemPrompt = composeSystemPrompt(request.spec, {
    rules: globalRuleBodies(request.policy.loadRules !== false),
  });
  const plugins = pluginFields(request, attempt, mcpComposition);
  const policy = spawnPolicy(request);
  const routeEnv = routeEnvFields(route);
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
      benchmarkMaxOutputTokens: attempt.backend === 'pi' && request.benchmark?.evidenceContext
        ? request.benchmarkMaxOutputTokens : undefined,
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
      ...(plugins.warnings ? { warnings: plugins.warnings } : {}),
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
      context,
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
    backend: backendField(request, attempt),
    process: policy.process,
  };
}
