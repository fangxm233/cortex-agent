/** Which agent CLI runs a session. Lives here rather than in `agent-adapter/types.ts` so the
 *  shared agent vocabulary under `core/agents/` can name a backend without importing the
 *  adapter; `agent-adapter/types.ts` re-exports it, so every existing import site is unchanged. */
export type Backend = 'claude' | 'pi';

export type ChatNoticeLevel = 'info' | 'warning' | 'error';

/**
 * A user turn the SYSTEM authored, not a human.
 *
 * Several mechanisms steer work back into a session by routing a synthetic user message: the
 * provider-recovery resume signal, task/thread completion callbacks, a subtask escalating a
 * question to its manager, and a backgrounded `agent` run reporting its answer. The backend has
 * always treated these as ordinary user turns (that IS how the model must read them), but a chat
 * surface has no way to tell them apart from something the human typed.
 *
 * This tag is that signal, and nothing more: it changes no routing, no prompt, no history
 * semantics. ABSENT MEANS HUMAN — every message written before this field existed, and every real
 * typed message, carries no tag, so no migration is needed and no honest user turn is ever
 * mistaken for a system one.
 *
 * Deliberately NOT tagged: a non-blocking `cortex_ask_user` answer (the human typed that text, it
 * merely arrives out of band) and the `[Scheduled Task]` fire prompt (the user wrote that
 * instruction; the UI already has its own presentation for it).
 */
export type SystemTurnOrigin =
  /** Provider rate limit / outage cleared — continuation signal for the interrupted turn. */
  | 'resume'
  /** A dispatched task reached a terminal state (completed or blocked). */
  | 'task-callback'
  /** A child thread finished and reported back to its parent session. */
  | 'thread-callback'
  /** A subtask escalated a question to the manager session (`ask_manager`). */
  | 'subtask-question'
  /** A backgrounded `agent` run delivered its result. */
  | 'agent-result'
  /** A waitpoint an agent armed was resolved by a signal from outside the process. */
  | 'external-signal';

export interface AuthNoticeAction {
  kind: 'auth-login';
  noticeId: string;
  backend: 'claude' | 'pi';
  provider: string;
  authType: 'oauth' | 'api_key';
}

/** A control the user can act on from a chat notice. Unlike AuthNoticeAction (an ephemeral
 *  live-tail hint) this is persisted with the message: the window it refers to can outlive a
 *  page reload by hours. */
export interface NoticeAction {
  kind: 'cancel-resume';
}

/** Backend-neutral snapshot of the tokens currently occupying an agent's context window. */
export interface ContextUsage {
  usedTokens: number | null;
  contextWindow: number;
  percent: number | null;
  accuracy: 'exact' | 'estimate';
}

/** Durable/live session form of a context snapshot. */
export interface SessionContextUsage extends ContextUsage {
  updatedAt: string;
}

/** One entry of the agent's task list. Identical in shape across backends. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Imperative form: "Run the test suite". */
  content: string;
  /** Present-continuous form shown while the item is in progress: "Running the test suite". */
  activeForm: string;
  status: TodoStatus;
}

/**
 * The agent's task list as of one TodoWrite call.
 *
 * TodoWrite is replace-all: every call carries the complete list, so a snapshot is self-contained
 * and the newest one is the truth. `total` / `completed` / `activeLabel` are derived, but travel
 * with the snapshot because most render targets (platform status line, TUI, mobile) need only
 * those three and must not each re-derive them — four implementations of the same fold would drift.
 */
export interface TodoSnapshot {
  items: TodoItem[];
  total: number;
  completed: number;
  /** activeForm of the first in-progress item; null when nothing is in progress. */
  activeLabel: string | null;
  updatedAt: number;
}

export interface AskUserQuestionInfo {
  toolUseId: string | null;
  questions: string[];
  sessionId: string;
}

export interface ReportedAccountingSnapshot {
  readonly usageReported: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly promptTokens: number | null;
  readonly cachedTokens: number | null;
  readonly model: string | null;
}

export interface AgentResult {
  sessionId: string | null;
  total_cost_usd: number | null;
  /** Present only when a provenance-sensitive caller needs reported zero distinguished from absent cost. */
  costReported?: boolean;
  /** Immutable result-event accounting used by provenance-sensitive event serialization. */
  reportedAccounting?: ReportedAccountingSnapshot;
  num_turns: number | null;
  rateLimited: boolean;
  rateLimitMessage: string | null;
  /** Opaque provider key used by provider-scoped throttle and resume bookkeeping. Set by the
   *  run layer for every attempt, including successful turns whose continuation may fail. */
  rateLimitProvider?: string;
  planFilePath: string | null;
  enteredPlanMode: boolean;
  exitedPlanMode: boolean;
  askUserQuestions?: AskUserQuestionInfo[];
  finalOutput: string | null;
  /** Number of background tasks (run_in_background) still running when this turn's
   *  result fired. >0 means the CC backend will spontaneously emit a continuation turn
   *  once they finish; orchestration holds the status in a "waiting" state instead of
   *  sealing it as complete. Absent/0 for backends without background-task support. */
  pendingBackgroundTasks?: number;
  /** Number of background tasks whose WORK finished (task_updated terminal status) but whose
   *  task_notification has not been observed. The CLI may deliver it seconds later — or never
   *  (old-CLI same-turn completions; 2026-07-10 investigation). Orchestration holds the status
   *  but arms a grace watchdog for these instead of waiting forever. Also +1 when a notification
   *  WAS observed during this turn but its own continuation turn has not opened yet — the CLI
   *  opens it right after this result (2026-09-06 investigation). */
  undeliveredBackgroundTasks?: number;
  /** Set on a synthetic continuation result produced when the Claude process died while
   *  background tasks were pending — the waiting status must seal as "interrupted". */
  backgroundInterrupted?: boolean;
}

export interface AgentProgress {
  num_turns: number | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
}
