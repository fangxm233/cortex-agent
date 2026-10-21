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
 * merely arrives out of band).
 */
export type SystemTurnOrigin =
  /** Provider rate limit / outage cleared — continuation signal for the interrupted turn. */
  | 'resume'
  /** Legacy, never written now: the retired task queue's terminal report, its thread runtime's
   *  completion report and a subtask's escalated question. Old transcripts still carry them. */
  | 'task-callback'
  | 'thread-callback'
  | 'subtask-question'
  /** A backgrounded `agent` run delivered its result. */
  | 'agent-result'
  /** A waitpoint an agent armed was resolved by a signal from outside the process. */
  | 'external-signal'
  /** A team lead handed work to one of its workers. */
  | 'team-lead'
  /** A worker reported the end of a turn to its lead. */
  | 'worker-result'
  /** A worker's pending question or plan was forwarded to its lead. */
  | 'worker-question'
  /** A schedule fired and opened its run with the prompt the user wrote for it. */
  | 'scheduled'
  /** Finished `run_in_background` work re-invoked the model with no turn in flight. */
  | 'background-task';

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

/** One image a tool returned to the model (`Read` on a picture, a screenshot tool), as base64.
 *  Carried in memory on the tool-result event only, until the transcript sink writes it to disk —
 *  no log, bus event or history line ever holds these bytes. */
export interface ToolResultImage {
  mimeType: string;
  data: string;
}

/** A file attached to a chat message (uploaded, sent by the agent, or an inbound platform file).
 *  The message carries the server-side path so the agent can read it directly. */
export interface AttachmentMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  /**
   * `view` is an agent-authored HTML document meant to be RENDERED in the chat (the `send_view`
   * MCP tool), not merely downloaded. It is minted only by the server-side view sender — the
   * upload classifiers (`classifyMime`, `classifyAttachment`) can never produce it, so a file a
   * user uploads is never executable no matter what its extension says. Renderers must treat this
   * bucket as untrusted content and load it in a `sandbox="allow-scripts"` frame WITHOUT
   * `allow-same-origin` (see web/src/features/media/html-sandbox.ts).
   */
  type: 'image' | 'video' | 'file' | 'view';
  /** Inline card width of a `view` attachment, chosen by the agent. Absent on other buckets and on
   *  views recorded before the field existed — renderers treat absence as `narrow`. */
  viewWidth?: ViewWidth;
}

/** `narrow` sits in the prose column, `wide` spans about one and a half columns, `full` spans the
 *  whole chat pane. Only the inline card honours it; expanded and docked views fill their host. */
export type ViewWidth = 'narrow' | 'wide' | 'full';

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
