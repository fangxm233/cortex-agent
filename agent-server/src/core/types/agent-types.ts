// input:  nothing (leaf type-only module)
// output: Agent results, auth actions, and exact usage types
// pos:    Shared type definitions for agent execution and messages
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export type ChatNoticeLevel = 'info' | 'warning' | 'error';

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

export interface AskUserQuestionInfo {
  toolUseId: string | null;
  questions: string[];
  sessionId: string;
}

export interface ReportedAccountingSnapshot {
  readonly usageReported: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
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
   *  agent facade for every attempt, including successful turns whose continuation may fail. */
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
   *  but arms a grace watchdog for these instead of waiting forever. */
  undeliveredBackgroundTasks?: number;
  /** Set on a synthetic continuation result produced when the Claude process died while
   *  background tasks were pending — the waiting status must seal as "interrupted". */
  backgroundInterrupted?: boolean;
}

export interface AgentHandle {
  promise: Promise<AgentResult>;
  kill: () => boolean;
  sessionId?: string | null;
  /** Opaque reference to the underlying agent process. Used by PI backend for sendExtensionUiResponse. */
  agentProcess?: unknown;
}

export interface AgentProgress {
  num_turns: number | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
}
