// input:  run options, resolved profile, tool gate, mode route
// output: canonical spawn config with execution and evidence context
// pos:    Registry-free spawn-config builder
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { resolveMcpComposition } from '../../agent-adapter/types.js';
import { canonicalizeMcpToolAllowlist, type PlanToolVariant } from '@core/mcp-tool-gate.js';
import type {
  AgentProcessSpawner, AgentSpawnConfig, Backend, McpComposition,
} from '../../agent-adapter/types.js';
import type { NormalizedEvent, TodoSnapshot, ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import type { AgentResult, ChatNoticeLevel, ContextUsage, NoticeAction } from '@core/types/agent-types.js';
import type { ProductionBenchmarkEvidenceContext } from '@core/types/thread-types.js';
import { GATEWAY_URL } from '../costs/gateway-manager.js';
import { loadCortexRules } from '../memory/rules-loader.js';
import { resolvePluginRuntime } from '../plugins/runtime.js';
import type { ModeEnv } from './config.js';
import type { ResolvedProfileConfig } from './profile-manager.js';

// --- Types ---

export interface AgentConfig {
  model: string;
  backend: Backend;
  mode: string | null;
  /** Opaque rate-limit provider identity; for PI it also selects the request protocol. */
  provider?: string | null;
  extraEnv?: Record<string, string>;
  extraOption?: Record<string, string>;
  /** DR-0012: Claude adapter mode (print/tui). Only meaningful for backend='claude'. */
  claudeBackend?: 'print' | 'tui';
  /** Thinking level from the profile (backend-native value: claude → --effort, pi → --thinking).
   *  null/undefined → nothing is passed. */
  thinking?: string | null;
  /** PI output cap resolved from the profile into the provider catalog. */
  maxOutputTokens?: number | null;
}

export interface RunObserver {
  onEvent(event: NormalizedEvent): void;
  onClose?(): void | Promise<void>;
}

export interface RunAgentOptions {
  profileName?: string | null;
  /** Backend resume target (Claude `--resume` / PI `--session`). null → fresh (backend self-assigns
   *  its own id). Decoupled from {@link trackSessionId}. */
  sessionId?: string | null;
  /** Stable Cortex tracking id (UI-facing identity) — surfaced as CORTEX_SESSION_ID only; does NOT
   *  drive backend resume. Defaults to `sessionId` when unset (threads / legacy callers). */
  trackSessionId?: string | null;
  sessionKey?: string | null;
  channel?: string;
  /** CDP endpoint for a browser-enabled session (plan/embedded-browser.md §17); null for the
   *  overwhelming majority of runs, which get no browser tools. */
  browserCdpEndpoint?: string | null;
  files?: unknown[];
  /** Best-effort synchronous event observers; failures are logged and ignored. */
  observers?: RunObserver[];
  /** Synchronous event sinks whose write or close failure aborts the run. */
  requiredSinks?: RunObserver[];
  /** Explicit background policy. Undefined preserves the legacy thread-keyed decision. */
  awaitBackground?: boolean;
  /** Completion-only disables ambient caps and waits until continuation or process termination. */
  backgroundWaitPolicy?: 'bounded' | 'completion-only';
  /** Absolute working directory resolved by the caller for the backend process. */
  cwd?: string;
  /** Optional containment-aware process boundary for daemon-free runs. */
  processSpawner?: AgentProcessSpawner;
  /** Pre-resolved spawn input used when identity must hash the exact object before launch. */
  preparedSpawnConfig?: AgentSpawnConfig;
  /** Optional absolute backend CLI path. */
  cliPath?: string;
  /** Exact allowlisted child environment for an isolated process. */
  pinnedEnv?: NodeJS.ProcessEnv;
  pluginDirs?: string[];
  /** Concrete MCP config paths frozen by a one-shot run config. */
  mcpConfigPaths?: string[];
  /** Suppress hooks for an isolated one-shot role. */
  disableHooks?: boolean;
  /** Explicit streaming policy for runs that must not load watched daemon settings. */
  streamDeltas?: boolean;
  /** Suppress legacy transcript logs when a required journal is configured. */
  captureTranscriptLogs?: boolean;
  /** Keep unavailable backend accounting null for provenance-sensitive runs. */
  preserveUnreportedAccounting?: boolean;
  /** Disable ambient global rules for a frozen role prompt. */
  loadCortexRules?: boolean;
  /** Disable daemon cost-store writes while preserving streamed cost records. */
  recordCost?: boolean;
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  isUserInitiated?: boolean;
  project?: string;
  trigger?: string;
  /** Cortex execution context surfaced to the MCP server child as CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME env vars.
   *  Read by the cortex_context / cortex_schedule_* MCP tools so LLMs can self-discover their thread and target schedules
   *  at the current thread / session without guessing IDs. */
  threadId?: string | null;
  sessionName?: string | null;
  /** Cortex execution record id, surfaced as CORTEX_EXECUTION_ID to subprocess env. */
  executionId?: string | null;
  /** Exact resolved profile used to freeze benchmark identity before adapter spawn. */
  resolvedProfileConfig?: ResolvedProfileConfig;
  /** Typed all-or-nothing benchmark facts persisted on the owning production thread. */
  productionBenchmarkEvidenceContext?: ProductionBenchmarkEvidenceContext | null;
  /** Production attempt ancestry and role values, consumed only by the identity freezer. */
  rootThreadId?: string | null;
  parentThreadId?: string | null;
  templateName?: string | null;
  agentSlotId?: string | null;
  stage?: string | null;
  identityDirective?: string;
  /** Explicit MCP privilege surface for the spawned backend. */
  mcpComposition?: McpComposition;
  /** Optional resolved per-tool MCP allowlist. */
  mcpToolAllowlist?: string[];
  /** Commission-mode plan-tool swap for this turn, resolved from the session record. */
  planToolVariant?: PlanToolVariant;
  /** True while the session is in commission mode (drafting a contract or bound to a landed one).
   *  Gates the commission skill bundle; broader than {@link planToolVariant}, which only covers the
   *  drafting window. */
  commissionMode?: boolean;
  /** Legacy thread-surface selector. Accepted for existing callers and resolved when the explicit
   *  composition is absent. */
  useCoreMcp?: boolean;
  /** Recursion depth of the owning thread, surfaced to the spawned agent as CORTEX_THREAD_DEPTH
   *  so the thread_start MCP tool can forward it for the depth guard. */
  threadDepth?: number | null;
  /** Owning dispatch task id/project, surfaced as CORTEX_TASK_ID / CORTEX_TASK_PROJECT so
   *  `cortex-task spawn` can infer the current task as the parent of a child task. */
  taskId?: string | null;
  taskProject?: string | null;
  taskGeneration?: string | null;
  onProgress?: ((progress: any) => void) | null;
  onContextUsage?: ((usage: ContextUsage) => void | Promise<void>) | null;
  /** A complete assistant text block. `blockId` ties it to prior deltas; `noticeLevel` turns
   *  system-authored text into semantic chat chrome without changing plain platform output.
   *  `subagent` is present only when a native subagent produced the text — its absence is how a
   *  surface tells the main agent's answer from a subagent's working notes. */
  onAssistantMessage?: ((msg: string, blockId?: string, noticeLevel?: ChatNoticeLevel, noticeAction?: NoticeAction, subagent?: ToolUseSubagent) => void) | null;
  /** An incremental text chunk of a block still being generated (never the accumulated total).
   *  Opt-in: callers that leave it unset receive complete messages only, exactly as before. */
  onAssistantDelta?: ((text: string, blockId: string) => void) | null;
  onToolUse?: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
  /** The agent's task list after a TodoWrite call. Replace-all: each snapshot is complete and
   *  supersedes the previous one, so consumers store rather than merge. Subagent lists are
   *  filtered out at the adapter boundary and never arrive here. */
  onTodoUpdate?: ((snapshot: TodoSnapshot) => void) | null;
  onToolResult?: ((toolUseId: string, content: string, isError: boolean, subagent?: ToolUseSubagent) => void) | null;
  onFallback?: (current: AgentConfig, next: AgentConfig, result: AgentResult | null, error?: Error) => Promise<void>;
  [key: string]: any;
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

// --- Scoped plugin gating ---

/** Plugins that load only for sessions originating from a specific platform channel.
 *  Mirrors the channel-gated MCP loading (loadFeishuMcp = channel.startsWith('feishu:')):
 *  the cortex-feishu skill bundle is only relevant when the user is working inside Feishu,
 *  so it is stripped from non-Feishu sessions even when listed in an agent's pluginDirs. */
export const CHANNEL_SCOPED_PLUGINS: ReadonlyArray<{ plugin: string; channelPrefix: string }> = [
  { plugin: 'cortex-feishu', channelPrefix: 'feishu:' },
];

/** Plugins that load only for sessions in commission mode. The commission skill is long and
 *  prescriptive (drill protocol, contract shape, checkpoint discipline); loading it into every
 *  session would put a procedure nobody asked for in front of the model (DR-0037 v2). */
export const COMMISSION_SCOPED_PLUGINS: readonly string[] = ['cortex-commission'];

/** What a plugin dir is scoped against. Both are properties of the session, not the agent, which
 *  is why the filter runs at spawn time rather than being baked into the agent's pluginDirs. */
export interface PluginScope {
  channel?: string;
  /** True while the session is in commission mode, drafting or already bound. */
  commissionMode?: boolean;
}

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
    return !!scope.channel && scope.channel.startsWith(rule.channelPrefix);
  });
}

/** @deprecated Kept for callers that only gate on the channel; prefer {@link filterScopedPlugins}. */
export function filterChannelScopedPlugins(
  dirs: string[] | undefined,
  channel: string | undefined,
): string[] | undefined {
  return filterScopedPlugins(dirs, { channel, commissionMode: false });
}

// --- Spawn config ---

type SpawnContext = NonNullable<AgentSpawnConfig['cortexContext']>;

function spawnContext(options: RunAgentOptions): SpawnContext {
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

function hasSpawnContext(context: SpawnContext): boolean {
  return Object.entries(context).some(([key, value]) => {
    return key === 'threadDepth' ? value != null : Boolean(value);
  });
}

function rulesPrompt(options: RunAgentOptions): string | undefined {
  const rules = options.loadCortexRules === false ? [] : loadCortexRules().global;
  return rules.length > 0
    ? rules.map(rule => rule.body).join('\n\n---\n\n')
    : undefined;
}

function spawnIdentity(
  options: RunAgentOptions,
  config: AgentConfig,
  mcpComposition: McpComposition,
): Pick<AgentSpawnConfig, 'sessionId' | 'sessionKey' | 'resume'> & Partial<AgentSpawnConfig> {
  return {
    sessionId: options.sessionId ?? null,
    sessionKey: options.sessionKey || options.channel || 'default',
    resume: !!options.sessionId,
    model: config.model,
    systemPrompt: typeof options.systemPrompt === 'string' ? options.systemPrompt : undefined,
    outputStyle: typeof options.outputStyle === 'string' ? options.outputStyle : undefined,
    cwd: options.cwd,
    mcpComposition,
  };
}

function spawnPolicy(options: RunAgentOptions): Partial<AgentSpawnConfig> {
  return {
    mcpConfigPaths: options.mcpConfigPaths,
    mcpToolAllowlist: options.mcpToolAllowlist === undefined
      ? undefined : canonicalizeMcpToolAllowlist(options.mcpToolAllowlist),
    planToolVariant: options.planToolVariant,
    disableHooks: options.disableHooks,
    streamDeltas: options.streamDeltas,
    captureTranscriptLogs: options.captureTranscriptLogs,
    preserveUnreportedAccounting: options.preserveUnreportedAccounting,
    processSpawner: options.processSpawner,
    cliPath: typeof options.cliPath === 'string' ? options.cliPath : undefined,
    pinnedEnv: options.pinnedEnv,
  };
}

function pluginSpawnFields(
  options: RunAgentOptions,
  config: AgentConfig,
  mcpComposition: McpComposition,
): Partial<AgentSpawnConfig> {
  const selectedPluginDirs = filterScopedPlugins(options.pluginDirs, {
    channel: options.channel,
    commissionMode: options.commissionMode,
  });
  const runtime = resolvePluginRuntime({
    backend: config.backend, selectedPluginDirs, mcpComposition,
  });
  return {
    pluginDirs: runtime.pluginDirs,
    pluginSkillDirs: runtime.pluginSkillDirs,
    mcpServers: runtime.mcpServers,
    pluginCapabilityFingerprint: runtime.pluginCapabilityFingerprint,
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
): Partial<AgentSpawnConfig> {
  const env = { ...(route ? routeEnvSets(route) : {}), ...extraEnv };
  const unsetEnv = route ? routeEnvDeletes(route, extraEnv) : [];
  return {
    env: Object.keys(env).length > 0 ? env : undefined,
    unsetEnv: unsetEnv.length > 0 ? unsetEnv : undefined,
  };
}

function adapterSpawnFields(
  options: RunAgentOptions,
  config: AgentConfig,
  route: ModeEnv | undefined,
): Partial<AgentSpawnConfig> {
  return {
    ...routeEnvFields(route, config.extraEnv),
    extraOption: config.extraOption && Object.keys(config.extraOption).length > 0 ? config.extraOption : undefined,
    claudeBackend: config.claudeBackend,
    thinking: config.thinking || undefined,
    channel: options.channel,
    claudeAgent: options.claudeAgent ?? undefined,
    callbackSource: options.callbackSource ?? undefined,
    scheduleTaskId: options.scheduleTaskId ?? undefined,
    isUserInitiated: !!options.isUserInitiated,
    rawTools: typeof options.tools === 'string' ? options.tools : undefined,
    anthropicBaseUrl: route?.ANTHROPIC_BASE_URL,
    browserCdpEndpoint: options.browserCdpEndpoint ?? undefined,
  };
}

function piSpawnFields(config: AgentConfig): Partial<AgentSpawnConfig> {
  const provider = config.backend === 'pi' ? config.provider : undefined;
  return {
    piProvider: provider || undefined,
    piModelMaxTokens: config.backend === 'pi' ? config.maxOutputTokens ?? undefined : undefined,
    piGatewayPath: provider
      ? buildPiGatewaySubPath(config.mode, provider)
      : undefined,
    piGatewayBaseUrl: config.backend === 'pi' ? GATEWAY_URL : undefined,
  };
}

export function buildAgentSpawnConfig(
  options: RunAgentOptions,
  config: AgentConfig,
  route: ModeEnv | undefined,
): AgentSpawnConfig {
  const mcpComposition = resolveMcpComposition(options.mcpComposition, options.useCoreMcp);
  const context = spawnContext(options);
  const appendSystemPrompt = rulesPrompt(options);
  return {
    ...spawnIdentity(options, config, mcpComposition),
    ...spawnPolicy(options),
    ...pluginSpawnFields(options, config, mcpComposition),
    ...adapterSpawnFields(options, config, route),
    ...piSpawnFields(config),
    cortexContext: hasSpawnContext(context) ? context : undefined,
    appendSystemPrompt,
  };
}
