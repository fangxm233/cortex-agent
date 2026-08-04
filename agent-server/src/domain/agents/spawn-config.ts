// input:  run options, agent config, route base URL
// output: the single backend-neutral AgentSpawnConfig every launcher hands an adapter
// pos:    Registry-free spawn-config builder
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { resolveMcpComposition } from '../../agent-adapter/types.js';
import type {
  AgentProcessSpawner, AgentSpawnConfig, Backend, McpComposition,
} from '../../agent-adapter/types.js';
import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import type { AgentResult, ChatNoticeLevel, ContextUsage } from '@core/types/agent-types.js';
import { GATEWAY_URL } from '../costs/gateway-manager.js';
import { loadCortexRules } from '../memory/rules-loader.js';

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
  /** Absolute backend CLI path frozen by a trial policy. Absent resolves the CLI from PATH. */
  cliPath?: string;
  /** Compiled benchmark policy guard for this role; present replaces the ambient hook surface. */
  benchmarkPolicyGuard?: AgentSpawnConfig['benchmarkPolicyGuard'];
  /** Exact allowlisted child environment for an isolated trial; replaces host inheritance. */
  pinnedEnv?: NodeJS.ProcessEnv;
  /** Absolute trial deadline a backend derives its in-process call budget from (§5.6 P5). */
  benchmarkDeadlineEpochMs?: number;
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
  /** Explicit MCP privilege surface for the spawned backend. */
  mcpComposition?: McpComposition;
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
   *  system-authored text into semantic chat chrome without changing plain platform output. */
  onAssistantMessage?: ((msg: string, blockId?: string, noticeLevel?: ChatNoticeLevel) => void) | null;
  /** An incremental text chunk of a block still being generated (never the accumulated total).
   *  Opt-in: callers that leave it unset receive complete messages only, exactly as before. */
  onAssistantDelta?: ((text: string, blockId: string) => void) | null;
  onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
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

// --- Channel-scoped plugin gating ---

/** Plugins that load only for sessions originating from a specific platform channel.
 *  Mirrors the channel-gated MCP loading (loadFeishuMcp = channel.startsWith('feishu:')):
 *  the cortex-feishu skill bundle is only relevant when the user is working inside Feishu,
 *  so it is stripped from non-Feishu sessions even when listed in an agent's pluginDirs. */
export const CHANNEL_SCOPED_PLUGINS: ReadonlyArray<{ plugin: string; channelPrefix: string }> = [
  { plugin: 'cortex-feishu', channelPrefix: 'feishu:' },
];

/** Drop channel-scoped plugin dirs whose channel prefix the current session does not match.
 *  Non-scoped plugins always pass through. Matched by the plugin dir's final path segment
 *  (basename) so substrings like `cortex-feishu-x` are not affected. */
export function filterChannelScopedPlugins(
  dirs: string[] | undefined,
  channel: string | undefined,
): string[] | undefined {
  if (!dirs) return dirs;
  return dirs.filter((dir) => {
    const base = dir.split('/').filter(Boolean).pop();
    const rule = CHANNEL_SCOPED_PLUGINS.find((r) => r.plugin === base);
    if (!rule) return true;
    return !!channel && channel.startsWith(rule.channelPrefix);
  });
}

// --- Spawn config ---

export function buildAgentSpawnConfig(
  options: RunAgentOptions,
  config: AgentConfig,
  anthropicBaseUrl: string | undefined,
): AgentSpawnConfig {
  // Pack the Cortex execution context only if at least one field is set, so adapters can
  // skip writing CORTEX_* env vars / route-context fields when there's nothing to report.
  const ctx = {
    threadId: options.threadId ?? null,
    profile: options.profileName ?? null,
    project: options.project ?? null,
    sessionName: options.sessionName ?? null,
    // Stable Cortex tracking id for CORTEX_SESSION_ID; falls back to the backend id (threads/legacy).
    trackSessionId: options.trackSessionId ?? options.sessionId ?? null,
    executionId: options.executionId ?? null,
    useCoreMcp: options.useCoreMcp ?? undefined,
    threadDepth: options.threadDepth ?? null,
    taskId: options.taskId ?? null,
    taskProject: options.taskProject ?? null,
    taskGeneration: options.taskGeneration ?? null,
  };
  const hasContext = !!(
    ctx.threadId || ctx.profile || ctx.project || ctx.sessionName || ctx.trackSessionId ||
    ctx.executionId || ctx.useCoreMcp || ctx.threadDepth != null || ctx.taskId ||
    ctx.taskProject || ctx.taskGeneration
  );

  // Load global rules (no paths frontmatter) and inject as appendSystemPrompt.
  // Scoped rules (with paths) are handled by the Read/Grep PostToolUse hook.
  const rules = options.loadCortexRules === false ? [] : loadCortexRules().global;
  const appendSystemPrompt = rules.length > 0
    ? rules.map(rule => rule.body).join('\n\n---\n\n')
    : undefined;

  return {
    sessionId: options.sessionId ?? null,
    sessionKey: options.sessionKey || options.channel || 'default',
    resume: !!options.sessionId,
    model: config.model,
    systemPrompt: typeof options.systemPrompt === 'string' ? options.systemPrompt : undefined,
    outputStyle: typeof options.outputStyle === 'string' ? options.outputStyle : undefined,
    cwd: options.cwd,
    mcpComposition: resolveMcpComposition(options.mcpComposition, options.useCoreMcp),
    mcpConfigPaths: options.mcpConfigPaths,
    disableHooks: options.disableHooks,
    streamDeltas: options.streamDeltas,
    captureTranscriptLogs: options.captureTranscriptLogs,
    preserveUnreportedAccounting: options.preserveUnreportedAccounting,
    processSpawner: options.processSpawner,
    cliPath: typeof options.cliPath === 'string' ? options.cliPath : undefined,
    benchmarkPolicyGuard: options.benchmarkPolicyGuard,
    pinnedEnv: options.pinnedEnv,
    benchmarkDeadlineEpochMs: options.benchmarkDeadlineEpochMs,
    pluginDirs: filterChannelScopedPlugins(
      Array.isArray(options.pluginDirs) ? options.pluginDirs : undefined,
      options.channel,
    ),
    env: config.extraEnv && Object.keys(config.extraEnv).length > 0 ? config.extraEnv : undefined,
    extraOption: config.extraOption && Object.keys(config.extraOption).length > 0 ? config.extraOption : undefined,
    claudeBackend: config.claudeBackend,
    thinking: config.thinking || undefined,
    channel: options.channel,
    claudeAgent: options.claudeAgent ?? undefined,
    callbackSource: options.callbackSource ?? undefined,
    scheduleTaskId: options.scheduleTaskId ?? undefined,
    isUserInitiated: !!options.isUserInitiated,
    rawTools: typeof options.tools === 'string' ? options.tools : undefined,
    anthropicBaseUrl,
    // PI-specific routing: provider name (= profile mode) + gateway base URL. PI adapter writes
    // a multi-provider models.json (writeProvidersConfig) so every PI provider lands on the
    // gateway. Claude ignores these fields.
    // PI routing: `provider` is the --provider (protocol; required for pi, validated at load — no
    // default). The gateway sub-path `/m/<mode>/<provider>` is derived from the profile's logical
    // `mode` (gateway.yaml owns the route).
    piProvider: config.backend === 'pi' && config.provider ? config.provider : undefined,
    piGatewayPath: config.backend === 'pi' && config.provider ? buildPiGatewaySubPath(config.mode, config.provider) : undefined,
    // P12: a trial is routed at its own proxy authority, which arrives as the route argument. The
    // host gateway is the daemon's default and must not be the value a trial takes.
    piGatewayBaseUrl: config.backend === 'pi' ? (anthropicBaseUrl ?? GATEWAY_URL) : undefined,
    cortexContext: hasContext ? ctx : undefined,
    appendSystemPrompt,
  };
}
