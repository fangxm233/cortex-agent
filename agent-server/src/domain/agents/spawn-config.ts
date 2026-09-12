// input:  run options, agent config, mode route
// output: AgentSpawnConfig via the EngineSpec bridge plus the legacy option types
// pos:    Deprecated flat spawn-config bridge (P2.1a); canonical builder is domain/runs/engine-spec.ts
// >>> Once updated, update this header and parent CORTEX.md <<<

import type {
  AgentProcessSpawner, AgentSpawnConfig, Backend, McpComposition,
} from '../../agent-adapter/types.js';
import type { NormalizedEvent, ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import type { AgentResult, ChatNoticeLevel, NoticeAction } from '@core/types/agent-types.js';
import type { ProductionBenchmarkEvidenceContext } from '@core/types/thread-types.js';
import { buildEngineSpec, specToSpawnConfig } from '../runs/engine-spec.js';
import type { ModeEnv } from './config.js';
import type { ResolvedProfileConfig } from './profile-manager.js';

// The Pi gateway derivation and the scoped-plugin gate now live with the EngineSpec builder in
// `domain/runs/engine-spec.ts`. Re-exported here so every existing importer keeps working.
export {
  buildPiGatewaySubPath, CHANNEL_SCOPED_PLUGINS, COMMISSION_SCOPED_PLUGINS,
  filterChannelScopedPlugins, filterScopedPlugins,
} from '../runs/engine-spec.js';
export type { PluginScope } from '../runs/engine-spec.js';

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
  /** Extra system-prompt text appended after the ambient rules — a subagent role's body arrives
   *  here. Independent of {@link loadCortexRules}: a frozen role sets both. */
  appendSystemPrompt?: string;
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
  /** Expose the commission-creation tools this turn. True only while a contract is being drafted. */
  commissionTools?: boolean;
  /** True while the session is in commission mode (drafting a contract or bound to a landed one).
   *  Gates the commission skill bundle; broader than {@link commissionTools}, which only covers the
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
  /** Full system-prompt override (replaces the backend default). P3.3 canonicalizes this. */
  systemPrompt?: string | null;
  /** Claude Code output style name (backend='claude'). */
  outputStyle?: string | null;
  /** Claude Code agent name (backend='claude'). */
  claudeAgent?: string | null;
  /** Legacy raw tool list: a comma string for Claude, canonical names for PI. */
  tools?: string | string[] | null;
  /** A complete assistant text block. `blockId` ties it to prior deltas; `noticeLevel` turns
   *  system-authored text into semantic chat chrome without changing plain platform output.
   *  `subagent` is present only when a native subagent produced the text — its absence is how a
   *  surface tells the main agent's answer from a subagent's working notes. */
  onAssistantMessage?: ((msg: string, blockId?: string, noticeLevel?: ChatNoticeLevel, noticeAction?: NoticeAction, subagent?: ToolUseSubagent) => void) | null;
  onFallback?: (current: AgentConfig, next: AgentConfig, result: AgentResult | null, error?: Error) => Promise<void>;
}

// --- Spawn config ---

/**
 * @deprecated P2.1a bridge. The canonical builder is now {@link buildEngineSpec}; this stays only
 * until the adapters and identity records move onto {@link EngineSpec} (P2.1b/P2.1c).
 */
export function buildAgentSpawnConfig(
  options: RunAgentOptions,
  config: AgentConfig,
  route: ModeEnv | undefined,
): AgentSpawnConfig {
  return specToSpawnConfig(buildEngineSpec(options, config, route));
}

