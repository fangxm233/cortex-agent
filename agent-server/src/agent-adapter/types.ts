import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import type { ProviderUsage } from '../domain/costs/usage-store.js';
import type { Capability } from './capabilities.js';
import type { NormalizedEvent, ToolUseSubagent } from './normalize/event-types.js';
import type { AwaitBackground } from './continuation-phase.js';
import type { RunEvent } from './run-events.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';

// Re-exported so every `import { Backend } from '.../agent-adapter/types.js'` keeps working;
// the definition moved to core so `core/agents/*` can name a backend without importing up.
import type { Backend } from '@core/types/agent-types.js';
export type { Backend };
export type McpComposition = 'direct' | 'thread-control' | 'none';

/** One provider rate-limit window as the backend reported it. Declared structurally here rather
 *  than imported from `domain/costs`: the adapter's job ends at observing the window, and what a
 *  throttle *means* is the host's decision (D10). Shaped to match the throttle's own input. */
export interface RateLimitObservation {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  rateLimitLabel?: string;
  utilization?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

/** Who the observation is attributed to — the gateway route the session actually used. */
export interface RateLimitOrigin {
  provider: string;
  displayName: string;
  mode?: string;
}

/** The host's throttle entry point, injected into an adapter at construction. Returns the
 *  submission promise so the caller can log a failure without owning the policy. */
export type RateLimitReporter = (
  info: RateLimitObservation,
  origin: RateLimitOrigin,
) => Promise<void>;

/** Cortex execution context surfaced to child processes as CORTEX_* env vars. */
export interface CortexContextEnv {
  threadId?: string | null;
  profile?: string | null;
  project?: string | null;
  sessionName?: string | null;
  /** Stable Cortex tracking id (decoupled from the backend `sessionId`). Surfaced as
   *  CORTEX_SESSION_ID so session-activity logs + MCP context tools key on the stable UI-facing
   *  identity rather than the backend CLI's self-assigned id. Falls back to `sessionId` when unset. */
  trackSessionId?: string | null;
  /** Cortex execution record id, surfaced as CORTEX_EXECUTION_ID to subprocess env. */
  executionId?: string | null;
  /** When true, load core + tasks + manager-answer + thread MCP layers. */
  useCoreMcp?: boolean;
  threadDepth?: number | null;
  /** Owning dispatch task identity surfaced through CORTEX_TASK_* variables. */
  taskId?: string | null;
  taskProject?: string | null;
  taskGeneration?: string | null;
}

/**
 * Backend-neutral engine description (plan §3.3). Backend-private options travel in the
 * `backend` discriminated union rather than as flat passthrough fields. Optionality is
 * load-bearing: several readers branch on `undefined` specifically, so an absent field must
 * stay absent and `undefined` must never be normalised to `null`/`false`/`[]`.
 */
export interface EngineSpec {
  engineKey: string;
  cwd?: string;
  resume: { backendSessionId: string | null; resume: boolean };
  model: { id?: string; provider?: string; thinking?: string; maxOutputTokens?: number };
  prompt: { system?: string; append?: string };
  tools: { canonical?: string[]; rawClaude?: string };
  plugins: { dirs?: string[]; skillDirs?: string[]; fingerprint?: string };
  mcp: { composition?: McpComposition; servers?: McpServerConfig[]; allowlist?: string[];
         configPaths?: string[]; browserCdpEndpoint?: string };
  env: { sets?: Record<string, string>; unsets?: string[]; pinned?: NodeJS.ProcessEnv;
         context?: CortexContextEnv };
  route: { anthropicBaseUrl?: string; gatewayBaseUrl?: string; gatewayPath?: string };
  flags: { disableHooks?: boolean; streamDeltas?: boolean; captureTranscripts?: boolean;
           preserveUnreportedAccounting?: boolean; isUserInitiated: boolean };
  context: { channel?: string; callbackSource?: string; scheduleTaskId?: string };
  extraOption?: Record<string, string>;
  backend:
    | { kind: 'claude'; claudeAgent?: string; outputStyle?: string; claudeBackend?: 'print' | 'tui' }
    | { kind: 'pi' };
  process: { spawner?: AgentProcessSpawner; cliPath?: string };
}

export interface AgentUsageScope {
  provider?: string;
  mode?: string;
}

export function resolveMcpComposition(
  explicit: McpComposition | undefined,
  useCoreMcp: boolean | undefined,
): McpComposition {
  if (explicit !== undefined) return explicit;
  return useCoreMcp === true ? 'thread-control' : 'direct';
}

export interface UserMessage {
  text: string;
  attachments?: { mimeType: string; path: string }[];
}

export interface McpStdioServerConfig {
  name: string;
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface McpRemoteServerConfig {
  name: string;
  type: 'streamable-http' | 'sse';
  url: string;
  headers: Record<string, string>;
}

/** Portable MCP server configuration carrying the full validated spawn-time runtime.
 *  @see DR-0008 §3.6 (MCP abstraction) and the portable plugin runtime resolver. */
export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface AgentProcessSupervision {
  started: Promise<{ pid: number; pgid: number }>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  quiescent: Promise<void>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  cancel(reason: 'cancel' | 'deadline'): void;
  dispose(): Promise<void>;
}

export interface SpawnedAgentProcess {
  process: ChildProcessWithoutNullStreams;
  supervision?: AgentProcessSupervision;
}

export type AgentProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => SpawnedAgentProcess;

/**
 * Where a BACKGROUND TURN reports itself: a turn the backend opened on its own, with no caller
 * awaiting it — a finished `run_in_background` task making the CLI re-invoke the model, or an
 * injected message the CLI consumed after the foreground result.
 *
 * A background turn is the same run, later, so this is a phase of the run and not a side channel:
 * `ContinuationPhase` installs it on the session and turns everything that arrives into `RunEvent`s
 * tagged `phase: 'background'`; the session never learns what happens next. Only Claude opens these
 * turns today (capability-gated), which is why the two members below follow the CLI's own lifecycle
 * (`onTurnOpen` when the CLI starts the turn, `onResult` when it ends).
 */
export interface BackgroundTurnSink {
  /** Optional: the continuation turn has opened (first assistant line arrived). The wait is over;
   *  holders pause their grace/max-wait watchdogs until `onResult` reports what remains. */
  onTurnOpen?: () => void;
  /** Assistant text from the continuation turn (append to the original reply). `subagent` is set
   *  only when a native subagent produced it (see ToolUseSubagent). */
  onAssistantText: (text: string, model?: string | null, subagent?: ToolUseSubagent) => void;
  /** Optional tool_use trace from the continuation turn, preserving its correlation id and,
   *  when a native subagent made the call, its attribution. */
  onToolUse?: (name: string, input: any, toolUseId?: string, subagent?: ToolUseSubagent) => void;
  /** Optional full normalized tool result from the continuation turn, with subagent attribution
   *  when the result belongs to a native subagent's own call. */
  onToolResult?: (
    toolUseId: string, content: string, isError: boolean, subagent?: ToolUseSubagent,
  ) => void;
  /** Optional exact context snapshot from the spontaneous provider call. */
  onContextUsage?: (usage: ContextUsage) => void;
  /** Optional authoritative end-of-subagent signal, keyed by the spawning tool call. Reported from
   *  the backend's own task lifecycle rather than inferred from the main agent speaking again —
   *  the only way to seal a killed or failed background subagent, which produces no notification. */
  onSubagentEnd?: (parentToolUseId: string, status: 'completed' | 'failed' | 'killed') => void;
  /** Continuation turn's terminating result. `result.pendingBackgroundTasks` is the number
   *  of background tasks still running (0 ⇒ safe to seal the status as complete). */
  onResult: (result: AgentResult) => void;
}

/**
 * Lifecycle acknowledgement for mid-turn injected messages.
 *
 * A successful backend write only queues the message. `onDelivered` fires when the backend begins
 * consuming it; `onUndelivered` seals an accepted message that the backend later rejects or loses.
 * `foldedIntoTurn` tells orchestration whether the already tracked run will carry the reply (`true`)
 * or a spontaneous background turn must carry it (`false`).
 */
export interface InjectionAckSink {
  /** Fired once per injected message, when the backend reports having consumed it. */
  onDelivered: (message: { text: string; foldedIntoTurn: boolean }) => void;
  /** Optional terminal edge for a message accepted by Cortex but never consumed by the backend. */
  onUndelivered?: (message: { text: string }) => void;
}

export interface AgentCompactUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface AgentCompactResult {
  status: 'compacted' | 'not-needed';
  tokensBefore: number | null;
  estimatedTokensAfter: number | null;
  contextUsage: ContextUsage | null;
  usage: AgentCompactUsage | null;
}

/**
 * One engine-side run (plan §3.3): the event stream and the foreground result for a single
 * `EngineSession.run()` call.
 */
export interface EngineRun {
  /** The run's events. Does NOT close at the foreground result: a session that owes background
   *  work keeps emitting with `phase: 'background'` until it emits `phase: 'done'` (D1). */
  events: AsyncIterable<RunEvent>;
  /**
   * The run's result. What it means depends on the `awaitBackground` policy the run was opened
   * with: `none`/`hold` resolve at the foreground turn, `inline`/`completion-only` resolve with the
   * merged result once the background phase ends.
   */
  result: Promise<AgentResult>;
  /**
   * The accumulated result of the WHOLE run — every chained continuation merged in — resolved when
   * the run ends, whatever the `awaitBackground` policy. `result` is what the caller's foreground
   * await gets (the same value for `none`/`hold`, the merged one for `inline`); this one is what a
   * terminal tally (execution metrics, cost) must read.
   */
  settled: Promise<AgentResult>;
  cancel(): void;
}

/** Options for one `EngineSession.run()`. */
export interface EngineRunOptions {
  awaitBackground: AwaitBackground;
  /**
   * Tap for the backend's raw `NormalizedEvent`s, in the order the backend produced them — the
   * wire-level record a benchmark journal needs and the run's `RunEvent` stream cannot reconstruct.
   * Deliberately a host PORT (the adapter may not import the domain): the engine owns the point
   * where raw events exist, and whoever needs raw evidence registers here.
   */
  onNormalizedEvent?: (event: NormalizedEvent) => void;
}

/**
 * A live backend session (Claude subprocess / PI SDK session); plan §3.3. Implemented by
 * `pi/engine.ts` and `claude/engine.ts`; `domain/runs/engines.ts: SessionEngines` owns lifetime.
 */
export interface EngineSession {
  readonly backend: Backend;
  /** The pool's reuse test: a stable string derived from the spec this session was opened from.
   *  Produced by the BACKEND (`pi.specIdentity` / `claude.specIdentity`), not by the shared
   *  `engineIdentity(spec)` — each backend's own identity covers resolved env / MCP / args and is
   *  strictly more precise. See the note on `engineIdentity` in domain/runs/engine-spec.ts. */
  readonly identity: string;
  /** Feature gates this *session* supports. Per session, not per backend (D9): a profile can
   *  declare a backend-level capability the concrete session does not implement, so the run layer
   *  consults this set rather than the backend capability matrix. */
  readonly capabilities: ReadonlySet<Capability>;
  readonly backendSessionId: string | null;
  run(prompt: UserMessage, opts: EngineRunOptions): EngineRun;
  /**
   * Mid-turn injection. `accepted:false` means the backend cannot take it right now.
   *
   * `injectionId` is the CALLER's correlation id (the pending-injection ledger's record id) and is
   * carried on the eventual `injection_delivered` / `injection_rejected` event. Omitted, the engine
   * mints one.
   */
  steer(msg: UserMessage, injectionId?: string): { accepted: boolean; injectionId?: string };
  /**
   * Push an out-of-band event into the live run's stream: a hosted child (a Claude native subagent)
   * keeps producing rows after its parent turn closed, and they belong to the parent's transcript.
   * Returns false when no run of this session is consuming events.
   *
   * This is a producer INTO the one stream, not a bypass of it — which is why it lives on the
   * session that owns the stream rather than on a process handle.
   */
  ingestExternal(event: RunEvent): boolean;
  /** Answer an in-flight dialog (ask_user / plan approval / …). Replaces PI's
   *  `sendExtensionUiResponse`. Returns false when no such dialog is open. */
  respondToDialog(dialogId: string, payload: Record<string, unknown>): boolean;
  compact(): Promise<AgentCompactResult>;
  close(): Promise<void>;
  kill(): boolean;
}

/**
 * Stateless engine factory (plan §3.3). Implemented by `PIAdapter` and `ClaudeAdapter`.
 * This is the only adapter contract: the pooled `AgentAdapter`/`AgentProcess` pair it replaced
 * (start/close/kill/list a session, then push turns into it) is gone, and the per-backend usage
 * probe a caller needs is asked of the adapter directly.
 */
export interface EngineAdapter {
  readonly backend: Backend;
  /** Pure construction: no pool, no registration, no side effects. The caller
   *  (`domain/runs/engines.ts: SessionEngines`) owns lifetime and reuse. */
  open(spec: EngineSpec): EngineSession;
  usage?(scope: AgentUsageScope): Promise<ProviderUsage[] | null>;
}
