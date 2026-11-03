import { getSettings } from '@core/settings.js';
import { canonicalizeMcpToolAllowlist } from '@core/mcp-tool-gate.js';
import type {
  EngineSpec, CortexContextEnv, McpComposition,
} from '../../agent-adapter/types.js';
import { resolveMcpComposition } from '../../agent-adapter/types.js';
import { composeSystemPrompt, globalRuleBodies } from './prompt.js';
import { workspacePrompt } from '@core/workspace.js';
import { resolvePluginRuntime } from '../plugins/runtime.js';
import type { ClaudeRoute } from '../connections/claude-route.js';
import { resolvePiAccountRoute } from '../connections/pi-account-dir.js';
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
      ...(request.policy.clean ? { clean: true } : {}),
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

/** What a PI run must never inherit: Claude's routing variables. */
const CLAUDE_ROUTING_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

/** Environment comes only from the resolved route, not user configuration. ANTHROPIC_BASE_URL is
 *  set through the dedicated `anthropicBaseUrl` spawn field rather than `sets`, so
 *  production-attempt-identity has one source for the attested route host; a route without a base
 *  URL deletes the variable so a child never inherits one. */
export function routeEnvFields(
  route: ClaudeRoute | undefined,
): { sets?: Record<string, string>; unsets?: string[] } {
  if (!route) return {};
  const sets = { ...route.sets } as Record<string, string>;
  const unsets: string[] = [...route.unsets];
  if (!route.baseUrl) unsets.push('ANTHROPIC_BASE_URL');
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

/** Claude: the resolved route. PI: the account's agent dir when the selection names an account. */
function specRoute(attempt: EngineSelection, route: ClaudeRoute | undefined): EngineSpec['route'] {
  const pi = resolvePiAccountRoute(attempt);
  if (pi) return { connection: pi.connection, piAgentDir: pi.agentDir };
  return {
    anthropicBaseUrl: route?.baseUrl,
    connection: route?.connection,
    ...(route?.configDir ? { claudeConfigDir: route.configDir } : {}),
  };
}

/**
 * Group the resolved inputs into the backend-neutral {@link EngineSpec}.
 * Pure re-grouping: every value, condition and defaulting rule is the original flat builder's.
 */
export function buildEngineSpec(
  request: RunRequest,
  attempt: EngineSelection,
  opts: { route?: ClaudeRoute; executionId?: string | null } = {},
): EngineSpec {
  const { route, executionId = null } = opts;
  const mcpComposition = resolveMcpComposition(request.policy.mcpComposition);
  const context = spawnContext(request, attempt, executionId);
  const appendSystemPrompt = composeSystemPrompt(request.spec, {
    rules: globalRuleBodies(request.policy.loadRules !== false),
    workspace: request.policy.clean && request.cwd ? workspacePrompt(request.cwd) : null,
  });
  const plugins = pluginFields(request, attempt, mcpComposition);
  const policy = spawnPolicy(request);
  const routeEnv = attempt.backend === 'pi' ? { unsets: [...CLAUDE_ROUTING_VARS] } : routeEnvFields(route);
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
    route: specRoute(attempt, route),
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
