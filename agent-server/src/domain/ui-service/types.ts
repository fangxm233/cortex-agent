import type { PlatformSettingsSnapshot } from '@core/platform-settings-spec.js';
export type { PlatformSettingsPatch, PlatformSettingsSnapshot, PlatformFieldSnapshot, PlatformFieldKey } from '@core/platform-settings-spec.js';

import type { SessionsSetStarredReturn, SessionsRenameReturn } from './session-metadata-schemas.js';
export type {
  SessionsSetStarredArgs, SessionsSetStarredReturn, SessionsRenameArgs, SessionsRenameReturn,
} from './session-metadata-schemas.js';

import type { z } from 'zod';
import type { queryInputSchemas, mutateInputSchemas } from './input-schemas.js';
import type { Project, CreateProjectResult } from '@domain/projects/index.js';
import type { CostSummary } from '@domain/costs/cost-tracker.js';
import type { ProviderUsage } from '@domain/costs/usage-store.js';
export type { ProviderUsage, UsageBilling, UsageFreshness, UsageWindow } from '@domain/costs/usage-store.js';
import type { ServerUpdateStatus } from '@domain/system/update-ui-state.js';
import type { SystemUpdateCheckResult } from '@domain/system/server-update-coordinator.js';
export type { SystemUpdateCheckResult } from '@domain/system/server-update-coordinator.js';
export type { ServerUpdateState, ServerUpdateStatus } from '@domain/system/update-ui-state.js';
import type { EventBus } from '@events/index.js';
import type { SessionStateReader } from '@core/session-state.js';
import type { SettingSnapshotEntry } from '@core/settings-spec.js';
import type {
  AttachmentMeta,
  AuthNoticeAction,
  ChatNoticeLevel,
  NoticeAction,
  SessionContextUsage,
  SystemTurnOrigin,
  TodoSnapshot,
} from '@core/types/agent-types.js';
export type {
  AuthNoticeAction,
  ChatNoticeLevel,
  NoticeAction,
  SessionContextUsage,
  SystemTurnOrigin,
  TodoItem,
  TodoSnapshot,
  TodoStatus,
} from '@core/types/agent-types.js';
import type { PlatformAdapter } from '@platform/adapter.js';
import type { SubagentSpawnRef } from '@core/subagent-spawn.js';
import type {
  HookBackend,
  HookEvent,
  HookFilterValue,
  HookResultMode,
  HookSource,
} from '@store/hook-registry.js';
import type { HookApplyTime, HookMountTarget } from '@domain/hooks/hook-view.js';
export type { HookApplyTime, HookMountTarget } from '@domain/hooks/hook-view.js';
import type { Session } from '@store/session-registry-repo.js';
import type { ExecutionRecord } from '@store/execution-repo.js';
import type { Waitpoint } from '@store/waitpoint-repo.js';
import type { SessionTotals } from '@store/session-totals.js';
export type { SessionTotals } from '@store/session-totals.js';
import type { ScheduleTask } from '@store/schedule-repo.js';
import type { ScheduleSpec, SchedulePatch } from '../scheduling/schedule-spec.js';
import type { CommissionRecord } from '@store/commission-repo.js';
import type { SessionHistory } from '@store/conversation-history-repo.js';
import type { Backend } from '../../agent-adapter/types.js';
import type { ProjectNote } from '@store/project-notes-repo.js';
import type {
  AuthLoginService,
  AuthLogoutResult,
  AuthLogoutSuccess,
  AuthStatusSnapshot,
  LoginFlowState,
  LogoutAccountInput,
} from '@domain/auth/index.js';
export type {
  AuthAccountState,
  AuthAccountStatus,
  AuthCredentialStatus,
  AuthStatusSnapshot,
  AuthType,
  LoginFlowNotice,
  LoginFlowState,
  LoginFlowStep,
  LoginOutcome,
  LoginPendingPrompt,
  LoginPromptOption,
} from '@domain/auth/index.js';
import type { CustomProviderStores, CustomProviderView } from '@domain/pi-providers/index.js';
export type {
  CustomProviderApi,
  CustomProviderModelSpec,
  CustomProviderView,
} from '@domain/pi-providers/index.js';
export type {
  ProviderRateLimitPolicyOverride,
  ProviderRateLimitWindowPolicyOverride,
  ProviderRateLimits,
} from '@core/settings-spec.js';

// ── Result ────────────────────────────────────────────────────────

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; code: string; message: string };
export type Result<T> = Ok<T> | Err;

// ── Query scopes ──────────────────────────────────────────────────

type QueryInputSchemas = typeof queryInputSchemas;
type MutateInputSchemas = typeof mutateInputSchemas;

/** Every query scope — the keys of `queryInputSchemas` (mirrored by `QueryReturnMap`). */
export type QueryScope = keyof QueryInputSchemas;

// ── Mutate ops ────────────────────────────────────────────────────

/** Every mutate op — the keys of `mutateInputSchemas` (mirrored by `MutateReturnMap`). */
export type MutateOp = keyof MutateInputSchemas;

// ── Subscribe ─────────────────────────────────────────────────────

export interface SubscribeFilter {
  events: string[];
  projectId?: string | null;
  /** Scope `session.message` events to a single session (S4 chat live stream). REQUIRED for
   *  `session.message.delta`: token-level previews are delivered to session-scoped subscriptions
   *  only, so an app-wide stream is never flooded with another session's deltas. */
  sessionId?: string | null;
}

export interface UiEvent {
  type: string;
  ts: string;
  payload: unknown;
}

// ── Query params / return types ───────────────────────────────────

export interface SessionsPendingInteraction {
  askUser: { requestId: string; questions: { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean }[]; blocking: boolean } | null;
  plan: { requestId: string; planContent: string; planFilePath: string | null } | null;
}


// ── Mutate args ───────────────────────────────────────────────────

export type AuthLogoutReturn = AuthLogoutSuccess;

export interface AuthSyncGatewayReturn {
  /** False when nothing was written (see `reason`); not an error. */
  configured: boolean;
  endpoints: number;
  profiles: string[];
  reason?: string;
}

export interface AuthRemoveCustomProviderReturn {
  removed: boolean;
}

// ── Attachment metadata (S4 chat file attachments, 15a) ──────────────────
// Describes a file uploaded through the web composer's "+ attach" / paste / drop.
// Files are stored under DATA_DIR/tmp/attachments/<sessionId>/ on the server;
// the message carries paths so the agent can read them directly.

export type { AttachmentMeta } from '@core/types/agent-types.js';

export interface SessionsMarkManyReadReturn {
  /** How many of the requested sessions were stamped — ids that no longer resolve (purged runs)
   *  are skipped rather than failing the batch. */
  marked: number;
}

/** The part of a session's engine selection that came from the user rather than from its profile.
 *  Every field is optional: a session may override only its thinking level, only its model, or any
 *  mix. Backend is never here — it belongs to the profile (and a live conversation cannot change it). */
export interface SessionSelectionOverride {
  model?: string;
  provider?: string;
  thinking?: string;
  /** Which gateway route of the profile's endpoint bills the turn — anthropic `plan` vs `api`. */
  mode?: string;
}

export interface SessionsSetCommissionReturn {
  /** The session's state after the call: which half of the mode it is in, if any. */
  phase: 'none' | 'draft' | 'active';
  commissionId: string | null;
  commissionDraft: string | null;
  /** True when leaving also deleted an untouched draft directory. */
  removedDraftDir?: boolean;
}

/** Return of sessions.answerQuestion / sessions.respondPlan. 'already-resolved' means another
 *  client (or Slack / timeout) resolved the interaction first — not an error; the caller
 *  refetches the transcript to show the final state. */
export interface SessionsInteractionMutateReturn {
  outcome: 'resolved' | 'already-resolved';
}

/** `already-approved` = a repeated approve (another device or a double-click) — idempotent,
 *  not an error; the card simply shows the recorded state. */
export interface SessionsRespondDecisionReturn {
  outcome: 'recorded' | 'already-approved';
}

/** `cancelled: false` means nothing was queued any more — the window reset and the turn
 *  already resumed. A late click is a no-op, not an error. */
export interface SessionsCancelResumeReturn {
  cancelled: boolean;
}

/** Fire-and-forget like sessions.send — the regenerated reply streams over `session.message`. */
export interface SessionsRewindReturn {
  accepted: true;
}

// Safely-writable config.set sections (Stage 7 + task b983). Each section has its own validated
// write path; any section not listed here is rejected by both the zod schema and the handler.
// `budget` writes budget.json (daily/monthly); `profiles` re-points the default profile (which must
// already exist in profiles.json — the write can only SELECT an existing profile, never invent one).
export interface BudgetValue {
  daily_usd: number;
  monthly_usd: number;
}

export interface ProviderRateLimitPolicy {
  provider: string;
  windowType?: string;
  windowLabel?: string;
  enabled: boolean;
  threshold: number | null;
}

// profiles.* — CRUD over the `profiles` map of profiles.json. `config.set {section:'profiles'}`
// still owns the ONE other write (re-pointing defaultProfile) and is untouched by these ops.
// The draft carries only the fields the settings editor can express; `extraEnv` (secret-bearing)
// and `fallback[]` (nested chain) are preserved from the stored entry across an update.
export interface ProfileDraftInput {
  model: string;
  backend?: Backend;
  mode?: string;
  provider?: string;
  thinking?: string;
  extraOption?: Record<string, string>;
}

export interface ProfilesCreateReturn {
  name: string;
}

export interface ProfilesUpdateReturn {
  changed: boolean;
}

export interface ProfilesRemoveReturn {
  removed: boolean;
}

// ── Query return types (DTOs) ─────────────────────────────────────

export interface ProjectConduitInfo {
  id: string;
  kind: 'research' | 'general';
  contextDir: string;
  hasMission: boolean;
  conduits: Record<string, string>;
}

export interface SessionInfo {
  /** The stable TRACK id (Cortex UI identity): registry key, `session.*` events, transcript, and every
   *  ui-service op key. Since the track/backend session-id decoupling this is NO LONGER the backend CLI
   *  resume target — use `backendSessionId` for that. */
  sessionId: string;
  /** The backend CLI resume target (`--resume`/`--session-id`) and session-backup file name — the id
   *  the "Session ID" surface shows as the backend UUID. Null on a fresh session before its first turn
   *  completes (no backend id assigned yet — never fabricated). Legacy records that predate the
   *  decoupling fall back to `sessionId` (where the conflated id WAS the backend id). */
  backendSessionId: string | null;
  name: string;
  projectId: string;
  backend: string;
  kind: 'local' | 'scheduled';
  /** How the session was initiated: 'direct' (user chat), 'thread' (pipeline/dispatch
   *  step), or 'scheduled' (scheduled job). The workbench session list shows only 'direct'. */
  origin: 'direct' | 'thread' | 'scheduled';
  /** The schedule (ScheduleInfo.id) whose fire produced this session — drives the left rail's
   *  per-schedule run grouping and the chat trigger card. Survives a reply converting the run to
   *  a direct session (provenance). Null for sessions with no schedule origin / legacy records. */
  scheduleId: string | null;
  /** The commission (CommissionInfo.id) this session is bound to — drives the left rail's
   *  commission grouping and the chat header banner. Bound at contract approval time
   *  (commission plan-exit); null for sessions outside any commission. */
  commissionId: string | null;
  /** Draft directory name while this session is in commission mode but its contract has not been
   *  named yet. Null once the contract lands (commissionId takes over) or outside the mode. */
  commissionDraft?: string | null;
  /** Team mode: the lead session that owns this worker; non-null means this session is a worker. */
  teamLeadId: string | null;
  /** The worker's short name within its team; null outside team mode. */
  workerName: string | null;
  /** Team mode: what the lead spawned this worker to do (first line of its spawn prompt, capped).
   *  Null for ordinary sessions and for workers spawned before the record carried it. */
  workerBrief?: string | null;
  /** Epoch ms when the worker was retired; null while active or outside team mode. */
  workerRetiredAt: number | null;
  createdAt: string;
  lastUsedAt: string;
  resumable: boolean;
  label: string | null;
  /** Optional for older fixtures/clients; sessions.list always supplies a boolean. */
  starred?: boolean;
  /** Explicitly renamed labels take precedence over generated scheduled-run titles. */
  labelRenamed?: boolean;
  /** The session's active agent profile (registry record). Null when never explicitly set — the
   *  client falls back to the config default. Kept in sync by the shared profile-switch rule. */
  profileName: string | null;
  /** The agent template the session runs as — its environment (prompt, tools, skills, rules), the
   *  other half of "what will the next turn be". Null when the session follows its channel's
   *  selection and, beneath that, the global default. Kept in sync by the agent-switch rule. */
  agentName?: string | null;
  /** What the user selected on top of that profile (model / provider / thinking), or null when the
   *  session runs its profile as declared. The composer needs both halves to show what the next turn
   *  will actually run; the profile alone would lie whenever a model was picked. */
  selectionOverride?: SessionSelectionOverride | null;
  /** Browser control this session opted into at creation, or null. Fixed for the session's life:
   *  the agent's tool set is decided when its process spawns, so this is a fact to display, not a
   *  setting to flip. */
  browser?: { device: string } | null;
  /** Latest backend context occupancy, or null until a supported backend reports one. Optional only
   *  for rolling compatibility with older servers/fixtures; current sessions.list always supplies it. */
  contextUsage?: SessionContextUsage | null;
  /** True only for PI and Claude print sessions under their fixed profile. */
  contextCompactionSupported?: boolean;
  /** The agent's latest task list, or null when it has not written one. Queryable snapshot half of
   *  snapshot+delta — `session.todos` is the delta. Live state, not persisted: a server restart
   *  ends the run that owned the list, so an absent list after boot is the truth. */
  todos?: TodoSnapshot | null;
  /** Live running snapshot: true while an interactive turn (a non-thread execution) is live on the
   *  session's channel. Authoritative at query time — the client uses this as the snapshot and the
   *  `session.status` event stream as the delta (snapshot + delta), so running state survives
   *  session switches, page reloads, and SSE reconnects. */
  running: boolean;
  /** Background-hold snapshot (web bg-hold): true while the session's foreground turn has ended but
   *  a background task (run_in_background Bash / background subagent) still holds it — `running`
   *  stays true throughout. Mirrors the `session.status` `backgroundRunning` delta via the in-memory
   *  bg-held registry (snapshot + delta, same pattern as `running`), so the state survives session
   *  switches, page reloads, and app restarts. False while a live foreground turn is on the channel. */
  backgroundRunning: boolean;
  /** Awaiting-user-action snapshot: true while the session is blocked on a pending interaction that
   *  needs the user to act — an ask-user question or a plan approval — resolved from the in-memory
   *  pending maps keyed by the session's channel (`getPendingAskUser`/`getPendingPlan`). This is the
   *  ONLY state that drives the rail's amber「需要你」dot; plain running and web bg-hold both render
   *  blue. False when nothing is pending, and false when the pending-interaction deps are absent
   *  (fixtures / TUI). Snapshot-only, mirrored live via the `session.interaction` event stream. */
  awaitingInput: boolean;
  /** How many waitpoints this session is still waiting on — external "wake me when X finishes"
   *  objects that are still `armed` (docs/waitpoints.md). Distinct from `awaitingInput`: that one
   *  means "blocked on YOU", this one means "blocked on a machine, nothing for you to do", which is
   *  why it must never drive the amber dot. Counted with the ownership union documented on
   *  WaitpointInfo (own sessionId OR own channel), deduped per waitpoint. 0 when nothing is pending
   *  and 0 when the waitpoint dep is absent (fixtures / TUI). Optional for rolling compatibility
   *  with older servers, like `totals` below — consumers read it as `?? 0`. */
  waitingOn?: number;
  /** Team mode: a worker's blocking questions and plans that were routed to its lead (counted here,
   *  not in `awaitingInput`, because the lead answers them). 0 for every other session. */
  waitingOnLead?: number;
  /** Real agent-turn count for the composer (NOT the number of user-message rounds). While running,
   *  the live count of the in-flight turn (from the running execution); while idle, the last run's
   *  final turn count (from the most recent non-thread execution on the session's channel). Null when
   *  unknown (a running turn before its first progress event, or a session that never ran). The client
   *  uses this as the snapshot and the `session.turn` event stream as the delta (snapshot + delta). */
  numTurns: number | null;
  /** Last run's total cost in USD for the composer status line. Sourced from the most recent
   *  non-thread execution on the session's channel (`metrics.costUsd`), the same run whose turn count
   *  drives `numTurns`. Null while running (cost is only finalized at turn end — there is no live
   *  in-memory cost source, so a running turn never falls back to the previous run's cost) and null
   *  when the session never ran. Snapshot-only (no live delta event); refreshed when sessions.list
   *  refetches on a turn-end status edge. */
  costUsd: number | null;
  /** WHOLE-SESSION cumulative stats — the counterpart of `numTurns`/`costUsd` above, which describe
   *  only the last run. Null when the session has never finished a run. Carries its own semantics
   *  (see SessionTotals): time and turns count the session's own runs, cost also includes the
   *  Agent-tool children those runs spawned. Optional for rolling compatibility with older servers.
   *  Snapshot-only, like `costUsd`: refreshed when sessions.list refetches on a turn-end edge. */
  totals?: SessionTotals | null;
  /** Unread: the session had activity (lastUsedAt, bumped at turn end) AFTER the user last viewed
   *  it (`sessions.markRead` → registry lastReadAt). Legacy records with no lastReadAt are treated
   *  as read (no unread flood on first deploy). */
  unread: boolean;
}

// ── sessions.transcript DTO (S4 chat) ─────────────────────────────
// Wraps conversation-history's per-session event stream, grouped into turns (each `user`
// event opens a turn). Streaming assistant partials are already collapsed at the source
// (conversationHistory.getHistory). An absent/empty history maps to `{ sessionId, turns: [] }`.

// ── Interaction entity DTO (web-interactions-redesign) ────────────────────
// An interaction (agent question / plan approval) is a first-class transcript row with a
// status machine. Pending rows render actionable cards; resolved/expired rows render
// summaries. The server derives `expired` at read time for pending rows whose live
// resolver is gone (restart) or older than the TTL.

export type InteractionKind = 'ask-user' | 'plan-approval';
export type InteractionStatus = 'pending' | 'answered' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface InteractionQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

// ── Decision entity DTO (send_decision) ───────────────────────────────────
// An agent-announced decision is a non-blocking record carried by an assistant transcript row.
// The user may respond (approve / explain / revise) — each response is an append-only action
// folded into `actions[]`; there is no pending state and nothing ever blocks the agent.

export type DecisionActionKind = 'approve' | 'explain' | 'revise';

export interface DecisionAction {
  action: DecisionActionKind;
  /** The chat message sent for explain/revise; absent for approve (nothing goes to the agent). */
  message?: string;
  ts: string;
}

export interface DecisionItem {
  id: string;
  title: string;
  decision: string;
  context: string;
  reasoning: string;
  actions: DecisionAction[];
}

export interface TranscriptInteractionDetail {
  id: string;
  kind: InteractionKind;
  status: InteractionStatus;
  payload: {
    questions?: InteractionQuestion[];
    /** Severity of an ask-user card ('info'|'warning'|'error') — absent = neutral look. */
    level?: ChatNoticeLevel;
    /** False only on a non-blocking ask-user card (the agent did not wait for it). */
    blocking?: boolean;
    planContent?: string;
    planFilePath?: string | null;
  };
  result?: { answers?: Record<string, string>; feedback?: string };
  resolvedVia?: string;
}

export interface TranscriptDebugDetails {
  /** Exact message sent to the agent for a user turn. */
  agentMessage?: string;
  /** Opaque reference for fetching one tool's full DEBUG payload. */
  toolRef?: string;
  /** Unabridged structured tool-call input. */
  toolInput?: unknown;
  /** Full correlated normalized tool result. */
  toolResult?: { content: string; isError: boolean };
  /** Derived at query time from the agent-server warning threshold; never persisted. */
  overCharacterThreshold?: true;
}

export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'tool' | 'interaction';
  /** user / assistant / interaction text; null for tool events. */
  text: string | null;
  /** tool name (tool events only). */
  toolName: string | null;
  /** compact tool input summary (tool events only). */
  toolInput: string | null;
  /** Remote execution target (remote tool events only). */
  toolDevice?: string;
  /** User rows only: Cortex authored this turn — a resume signal, a task/thread callback, a
   *  subtask's question, a backgrounded agent's result — rather than a human typing it. Chat
   *  surfaces render it as a one-line hint instead of a user bubble. Absent = human. */
  systemOrigin?: SystemTurnOrigin;
  /** Sensitive lossless data. Present only in responses produced while server DEBUG is enabled. */
  debug?: TranscriptDebugDetails;
  /** Semantic chat-notice styling for system-authored assistant messages. */
  noticeLevel?: ChatNoticeLevel;
  /** Control the notice offers (e.g. declining a promised auto-resume). */
  noticeAction?: NoticeAction;
  /** Secret-free one-click target carried only by authentication notices. */
  authAction?: AuthNoticeAction;
  /** interaction subtype: 'ask-user-answered' | 'plan-approved' | 'plan-rejected' (legacy rows)
   *  or derived from kind+status for entity rows (display compat). */
  subtype?: string;
  /** Structured interaction entity (interaction rows with an id). Absent on legacy rows. */
  interaction?: TranscriptInteractionDetail;
  /** File attachments: user uploads via the web composer (15a, user messages), agent-sent
   *  files via the `send_file` MCP tool (20a, assistant messages), or the images a tool call
   *  returned to the model (tool messages). */
  attachments?: AttachmentMeta[];
  /** Agent-announced decisions via the `send_decision` MCP tool (assistant messages). */
  decisions?: DecisionItem[];
  /** Present on a user message that replaced an earlier one via edit+rewind (sessions.rewind):
   *  the original text/ts backing the「已编辑」badge + hover/tap original-message card. */
  edited?: { originalText: string; originalTs: string };
  /** Native-subagent grouping key on rows produced by one child. Absent = main agent. */
  subagentId?: string;
  /** Complete prompts for every child spawned by this main-agent tool row. */
  subagentSpawns?: SubagentSpawnRef[];
  /** Declared subagent type, e.g. `explore`. Reported on the subagent's rows, not the anchor. */
  subagentType?: string;
  /** The spawning call's task description as the backend reports it. */
  subagentDescription?: string;
  /** The model that produced this row, as the subagent's own messages report it. Absent on the
   *  anchor and on history written before the field existed — absent means unknown. */
  subagentModel?: string;
  /** Terminal state the backend reported for the subagent named by `subagentId`. Live-only: it
   *  corrects that block's status while the session is held open and is never persisted, because
   *  a session that is no longer live re-derives every block as done anyway. */
  subagentEnded?: 'completed' | 'failed' | 'killed';
  ts: string;
  /**
   * Real elapsed since the previous message in the session's chronological stream, in ms
   * (derived from `ts` deltas). Null for the first message and when either ts is unparseable.
   * Per-message cost has no real attribution source (conversation-history carries no cost; the
   * cost store is keyed by project/trigger, not session/turn/message) — deliberately absent, not
   * a fabricated null field.
   */
  elapsedMs: number | null;
}

export interface TranscriptTurn {
  turnIndex: number;
  messages: TranscriptMessage[];
}

export interface PendingTranscriptUserMessage {
  id: string;
  text: string;
  ts: string;
  attachments?: AttachmentMeta[];
  /** Same signal as `TranscriptMessage.systemOrigin`, on a row that is not committed yet. */
  systemOrigin?: SystemTurnOrigin;
}

export interface TranscriptSubagentSummary {
  id: string;
  type?: string;
  description?: string;
  model?: string;
  toolCount: number;
  hasDetails: boolean;
  structurallyOpen: boolean;
  /** Explicit per-child lifecycle authority; absent for legacy structural inference. */
  status?: 'running' | 'completed' | 'failed' | 'killed';
}

/** Rows that changed since a client's cursor, addressed by flat position across the transcript. */
export interface TranscriptDeltaRow {
  /** Position in the flattened row stream (turns concatenated in order). */
  index: number;
  turnIndex: number;
  message: TranscriptMessage;
}

export interface TranscriptDelta {
  changed: TranscriptDeltaRow[];
  /** Row count now. A client drops anything at or past it, which is how a rewind shortens. */
  total: number;
}

export interface SessionTranscript {
  sessionId: string;
  turns: TranscriptTurn[];
  /** Durable messages accepted into a live backend turn but not consumed by the model yet.
   *  Optional for rolling compatibility with older servers; current servers always return it. */
  pendingUserMessages?: PendingTranscriptUserMessage[];
  /** Compact opt-in only. Present even when empty; absent on full transcript responses. */
  subagentSummaries?: TranscriptSubagentSummary[];
  /** Compact opt-in only. Pass back as `since` to get the next response as a delta. Absent when
   *  the server cannot serve deltas for this read. */
  cursor?: string;
  /** Present INSTEAD of a populated `turns` when the response answers a `since` cursor. A client
   *  that does not understand it must not send `since`. */
  delta?: TranscriptDelta;
}

export interface SessionSubagentTranscript {
  sessionId: string;
  subagentId: string;
  messages: TranscriptMessage[];
}

export interface ScheduleInfo {
  id: string;
  type: 'interval' | 'daily' | 'weekly' | 'once';
  message: string;
  projectId: string;
  /** The agent profile this schedule runs under, from the schedule config source.
   *  null for legacy records that never recorded a profile (honest placeholder — no fabrication). */
  profile: string | null;
  nextRun: string | null;
  lastRun: string | null;
  paused: boolean;
  pausedBy: string | null;
  /** Timing spec — only the field(s) matching `type` are set; the rest are null.
   *  Drives cadence labels ("daily 07:30") and edit-form prefill. */
  intervalMs: number | null;
  time: string | null;
  dayOfWeek: number | null;
}

// ── Commission DTOs (DR-0037) ─────────────────────────────────────
// Registry facts only. The contract/ledger TEXT is not part of this DTO — clients read those via
// the existing `memory.file` query (`commissions/<slug>/ledger.md` relative to the project root),
// and gate state is derived live from member sessions' awaitingInput, never stored.

export interface CommissionInfo {
  id: string;
  projectId: string;
  /** Final directory name under `<project context>/commissions/` — fixed at approval time. */
  slug: string;
  title: string;
  status: 'active' | 'done' | 'abandoned';
  createdAt: string;   // ISO; approval time
  updatedAt: string;   // ISO
  closedAt: string | null;
  closeNote: string | null;
}

/** One decision card in the commission board's stream: a projected send_decision item with its
 *  user responses merged in (same DecisionItem shape the transcript renders), plus provenance. */
export interface CommissionDecisionEntry {
  /** ISO ts of the send_decision call — the stream's ordering key. */
  ts: string;
  /** The session that announced the decision (source row on the board card). */
  sessionId: string;
  item: DecisionItem;
}

/** One signal that has landed on a waitpoint. `message`/`member`/`source` are written by the
 *  external process — plain text only, never interpreted. */
export interface WaitpointSignalInfo {
  at: number;
  status: 'ok' | 'fail' | 'progress';
  member: string | null;
  message: string | null;
  source: string;
}

/** One waitpoint a session is still waiting on (docs/waitpoints.md). Only `armed` ones are returned:
 *  a fired or expired waitpoint has already posted its own notice into the transcript, so repeating
 *  it in a panel would tell the same story twice.
 *
 *  OWNERSHIP — a waitpoint belongs to a session when EITHER holds:
 *    `owner.sessionId === session.sessionId`  the session armed it, or
 *    `owner.channel   === session's channel`  the wake will be delivered HERE.
 *  Both clauses are needed. The first survives a channel rebind (`bindChannel` does not rewrite
 *  `record.channel`); the second survives the session being recreated (`!new`, a scheduled re-run),
 *  because delivery is channel-addressed and find-or-creates a session. A consequence worth knowing:
 *  the second clause can legitimately surface a waitpoint armed by an EARLIER session on the same
 *  channel — that is honest, since its wake really will land on the current one.
 *
 *  SECURITY: built field-by-field from the stored record, never by spreading it, so the capability
 *  secret hash cannot leak by omission. `signals[].data` is deliberately absent — externally written
 *  and capped at 16 KB per signal, it would bloat every list response. */
export interface WaitpointInfo {
  /** `wp_<12 hex>` — public, appears in notices and in the signal command line. */
  id: string;
  /** Agent-written short name. */
  label: string;
  /** What the agent said it was waiting for, in its own words. */
  intent: string;
  /** Always `armed` today; the wider union is carried so the shape survives if settled waitpoints
   *  are ever surfaced. */
  state: 'armed' | 'fired' | 'expired' | 'cancelled';
  /** Where the signal is expected from. `device` names the machine whose spool dir the sweep drains. */
  emitFrom: { kind: 'local' } | { kind: 'device'; device: string };
  /** Quorum progress. `got` counts distinct REPORTER KEYS, not signals: named members are deduped,
   *  anonymous signals take synthetic slots. So `got` can exceed `members.length`, and a per-member
   *  checklist must never be rendered from `members` alone. */
  quorum: { need: number; got: number; members: string[] };
  /** A single `fail` resolves it with the quorum unmet — which is why a resolved waitpoint can
   *  legitimately read "1 of 3". */
  failFast: boolean;
  /** Mailbox mode. After each fire below `maxSignals` the quorum counter resets, so progress
   *  appearing to go backwards is not a bug — `fires`/`maxSignals` is what disambiguates it. */
  fires: number;
  maxSignals: number;
  createdAt: number;
  expiresAt: number;
  /** Signals received so far, oldest first. Includes `progress` reports, which never resolve. */
  signals: WaitpointSignalInfo[];
  /** Delivery write-ahead bit. `pending && attempts > 1 && lastError` is the silent failure
   *  "the signal landed but the wake did not, and it is being retried" — invisible everywhere else.
   *  `lastError` is a locally generated message, not attacker input. */
  delivery: { pending: boolean; attempts: number; lastError: string | null; lastAt: number | null };
  /** Wakes spent in the trailing hour, and the cap they are counted against. */
  wakesLastHour: number;
  wakeLimit: number;
  /** True once the rate limit has bitten: further signals are RECORDED BUT NEVER WAKE the session,
   *  and the flag is never reset. The loudest thing this DTO carries. */
  rateLimited: boolean;
}

export interface ExecutionInfo {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
  sessionId: string | null;
  projectId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  cost: number | null;
}

// Full single-execution detail for the execution detail screen (F3/8b right pane).
// Superset of ExecutionInfo's identifying fields plus nested lifecycle / metrics / text.
export interface ExecutionDetailInfo {
  id: string;
  /** Android shells up to 2026.10.6 require this field (and `threadId`) when parsing the detail;
   *  newer shells read only status, sessionId and projectId. */
  kind: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
  projectId: string | null;
  sessionId: string | null;
  /** Always null. Kept for the released Android shells noted on `kind`. */
  threadId: null;
  runtime: { startedAt: string; updatedAt: string; endedAt: string | null };
  metrics: { costUsd: number | null; numTurns: number | null; durationS: number | null };
  text: { label: string | null; finalOutput: string | null; error: string | null };
}

// ── config.get snapshot DTO (Stage 7 settings 12a–g) ──────────────
// Redacted read of ~/.cortex/config for the settings panel. Every field is null / [] when its
// source file is absent. SECURITY INVARIANT: `.env` values are NEVER returned — only the key,
// a present flag, and a fixed mask string. `machines[].ssh` is a presence flag, not the raw
// user@host string. No secret / credential ever appears in this DTO.

export interface ConfigBudget {
  daily_usd: number | null;
  monthly_usd: number | null;
  /** Per-project overrides keyed by project id. Empty when every project inherits the globals.
   *  Entries are pair-only by construction — a malformed half-pair on disk is dropped, not
   *  surfaced as a partially-null override. */
  projects: Record<string, BudgetValue>;
}

export interface ConfigProfileEntry {
  name: string;
  model: string | null;
  backend: Backend | null;
  mode: string | null;
  /** Thinking level (backend-native value: claude --effort / pi --thinking). */
  thinking: string | null;
  /** Rate-limit provider identity; required by profiles whose effective backend is 'pi'. */
  provider: string | null;
  /** Extra CLI flags (keys start with '--'). Returned in full — the editor must round-trip them. */
  extraOption: Record<string, string>;
  /** KEYS ONLY of `extraEnv`. Values are environment injection and may hold a token, so they are
   *  never returned; an edit preserves the stored values untouched. */
  extraEnvKeys: string[];
  /** Number of declared fallback entries. The fallback chain itself is not editable from the UI. */
  fallbackCount: number;
}

export interface ConfigProfiles {
  defaultProfile: string | null;
  profiles: ConfigProfileEntry[];
}

export interface ModelCatalogRoute {
  /** Gateway endpoint group: 'anthropic' for claude, the PI provider name otherwise. */
  endpoint: string;
  backend: Backend;
  /** PI `--provider`; null for claude, whose provider identity is not a profile field. */
  provider: string | null;
  /** Mode names gateway.yaml actually declares for this endpoint, in file order. Never empty: an
   *  endpoint with no gateway section falls back to the name `discoverEndpoints` would generate. */
  modes: string[];
  /** Selectable model ids. Empty means "known route, unknown models" — free text, not an error. */
  models: string[];
  /** Where the route was first seen: the built-in Anthropic table, PI's scan of logged-in
   *  providers, a user-defined provider, or gateway.yaml alone (⇒ likely not logged in). */
  source: 'builtin' | 'pi' | 'custom' | 'gateway';
  /** Thinking levels keyed by model id, for the models whose source could tell — PI reports each
   *  model's own ladder. A model absent from this map accepts `thinkingLevels` below: the catalog
   *  never narrows what it cannot vouch for. Optional while clients and servers roll
   *  independently; an older server omits it and every model gets the backend's whole ladder. */
  modelThinking?: Record<string, string[]>;
}

export interface ModelCatalogSnapshot {
  routes: ModelCatalogRoute[];
  /** True while PI's first model scan is still in flight — the client may refetch shortly. */
  piPending: boolean;
  /** The backend-wide thinking ladders, served so a picker does not keep a second copy of the
   *  table the profile validator already enforces. Optional for the same roll-skew reason as
   *  `modelThinking`. */
  thinkingLevels?: Record<Backend, string[]>;
}

export interface ConfigMachine {
  name: string;
  cortexPath: string | null;
  gpuCount: number | null;
  ssh: boolean;
  win: boolean;
}

export interface ConfigMcp {
  servers: string[];
}

/** One execution environment (`config/environments/`) as a picker needs it: what it is for, and
 *  which profile it pins (or `__active__` — it runs whatever the conversation's own profile
 *  resolves to). */
export interface ConfigAgentEntry {
  name: string;
  description?: string;
  profile: string;
}

export interface ConfigEnvEntry {
  key: string;
  present: boolean;
  masked: string;
}

export type ConfigSettingEntry = SettingSnapshotEntry;

export interface ConfigHook {
  id: string;
  event: HookEvent;
  enabled: boolean;
  source: HookSource;
}

// ── hooks.* DTOs ─────────────────────────────────────────────────────────────
// Full read/write model of the declarative hook registry. `ConfigHook` above stays the four-field
// summary embedded in config.get; anything that edits a declaration uses HookDetail instead.

/** `run` flattened for the editor: exactly one of script/command is non-null. */
export interface HookRunInfo {
  script: string | null;
  command: string | null;
  /** Registry timeout in SECONDS. */
  timeoutSec: number | null;
}

export interface HookScopeInfo {
  backends: HookBackend[] | null;
  requiresTool: string | null;
}

export interface HookDetail {
  id: string;
  event: HookEvent;
  /** Regex matcher for agent:/cc:/pi: events; null when the event uses filters or has no matcher. */
  matcher: string | null;
  /** Equality filters for cortex:* events; null otherwise. */
  matcherFilters: Record<string, HookFilterValue> | null;
  run: HookRunInfo;
  scope: HookScopeInfo | null;
  blocking: { mode: 'webhook'; ttlMin: number } | null;
  result: HookResultMode | null;
  enabled: boolean;
  source: HookSource;
  /** CalVer stamp for managed entries; null for user entries. */
  version: string | null;
  /** Declaration filename. Typed nullable for clients built against the older shape. */
  fileName: string | null;
  /** Position in load order — which is also execution order within one event. */
  order: number;
  /** Where the declaration actually installs once compiled. */
  mountsOn: HookMountTarget[];
  /** Result modes the loader accepts for this event, for a constrained editor choice. */
  legalResults: HookResultMode[];
  appliesAt: HookApplyTime;
  /** Whether run.script resolves on disk; null when the hook is command-based. */
  scriptExists: boolean | null;
  /** True only for user entries — managed gets resynced. */
  editable: boolean;
  /** Always null. Kept so released mobile clients that still read them keep parsing the detail. */
  template: null;
  phase: null;
}

export interface HookScriptInfo {
  name: string;
  usedBy: string[];
}

export interface HooksOverview {
  hooks: HookDetail[];
  scripts: HookScriptInfo[];
  hooksDir: string;
}

/** The editable surface of a declaration, flattened so the form binds one field per control. */
export interface HookDraftInput {
  event: string;
  matcher?: string;
  matcherFilters?: Record<string, HookFilterValue>;
  script?: string;
  command?: string;
  timeoutSec?: number;
  backends?: HookBackend[];
  requiresTool?: string;
  result?: HookResultMode;
  enabled?: boolean;
}

export interface HooksCreateReturn {
  id: string;
  fileName: string;
}

export interface HooksUpdateReturn {
  changed: boolean;
}

export interface HooksSetEnabledReturn {
  changed: boolean;
  /** Non-null when the change is not durable (a managed entry a later sync will restore). */
  warning: string | null;
}

export interface HooksRemoveReturn {
  removed: boolean;
}

export interface HooksTestReturn {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** What a brand-new conversation starts on: the profile the composer should preselect, plus the
 *  model / provider / thinking / route the last pick left on top of it. Null on a host where
 *  nobody has picked anything yet — the composer then falls back to the default profile. */
export interface ConfigSelectionDefault extends SessionSelectionOverride {
  profileName?: string;
  /** The agent the last composer pick ran as — a draft opens in the environment the previous
   *  conversation was working in, the same way it opens on its profile. */
  agentName?: string;
}

export interface ConfigSnapshot {
  platforms?: PlatformSettingsSnapshot[];
  budget: ConfigBudget | null;
  profiles: ConfigProfiles | null;
  machines: ConfigMachine[];
  mcp: ConfigMcp | null;
  /** The execution environments a composer may pick from, with what each one is and pins. Always
   *  emitted by current servers; optional while clients and servers roll independently. */
  agents?: ConfigAgentEntry[];
  hooks: ConfigHook[];
  env: ConfigEnvEntry[];
  /** Always emitted by current servers; optional while clients and servers roll independently. */
  settings?: ConfigSettingEntry[];
  /**
   * The ONE language knob: it is what every server-side t() string renders in AND what the Web UI
   * picks its vocabulary from. `value` is the live process locale (what Cortex is speaking right
   * now), not merely what is on disk — a !lang switch is reflected before any restart.
   * Optional while clients and servers roll independently: an older server omits it and the SPA
   * falls back to its local cache.
   */
  lang?: ConfigLang;
  /** Seed for a draft composer — see {@link ConfigSelectionDefault}. Optional while clients and
   *  servers roll independently. */
  selectionDefault?: ConfigSelectionDefault | null;
}

export interface ConfigLang {
  value: 'en' | 'zh';
  /** Where that value came from — 'env' means CORTEX_LANG re-wins on the next restart. */
  source: 'env' | 'file' | 'default';
}

// ── machines.list DTO (plan §12 A item 1) ────────────────────────────────────
// Joined view of machines.json (static config) + client-manager (live online state).
// SECURITY: ssh field is a presence flag only — the raw user@host string is never returned (same
// convention as config.get ConfigMachine.ssh).

export interface MachineInfo {
  /** Machine name (key from machines.json). */
  name: string;
  /** Absolute path to the cortex data directory on the machine; null when unset. */
  cortexPath: string | null;
  /** Number of GPUs on the machine; null when unset. */
  gpuCount: number | null;
  /** True when an SSH string is configured (presence flag — raw value never exposed). */
  sshConfigured: boolean;
  /** Platform family derived from the `win` flag in machines.json. */
  os: 'windows' | 'unix';
  /** True when the machine's cortex-client is connected via WebSocket right now. */
  online: boolean;
  /** ISO timestamp of the WebSocket connection; null when offline. */
  connectedAt: string | null;
  /** ISO timestamp of the last heartbeat received; null when offline. */
  lastHeartbeat: string | null;
  /** Capabilities advertised by the cortex-client on connect; [] when offline. */
  capabilities: string[];
}

// ── machines.detail DTO ──────────────────────────────────────────────────────
// Live per-machine probe, fetched lazily when a machine card is expanded. One bash round trip to
// the device (nvidia-smi + nproc/loadavg/free/df/uptime).
// Never folded into machines.list: probing is an RPC to a possibly-slow device, so it stays behind
// an explicit expand. A failed or unavailable probe is reported via probeError, never as empty data.

/** A compute process holding memory on a GPU (from `nvidia-smi --query-compute-apps`). */
export interface MachineGpuProcess {
  pid: string;
  /** Process name as reported by nvidia-smi (may be a bare name or a full path). */
  name: string;
  memoryMb: number;
}

export interface MachineGpu {
  /** CUDA device ordinal. */
  index: number;
  name: string;
  utilPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  tempC: number;
  powerW: number;
  processes: MachineGpuProcess[];
}

/** Host vitals in absolute units; every field is null when the host did not report it. */
export interface MachineVitals {
  cpuCores: number | null;
  loadAvg1: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  /** Free/total space on the filesystem holding the machine's cortexPath. */
  diskFreeGb: number | null;
  diskTotalGb: number | null;
  uptimeSec: number | null;
}

export interface MachineDetail {
  name: string;
  online: boolean;
  /** null when the machine is offline or the probe failed. */
  vitals: MachineVitals | null;
  /** Empty when the machine is offline, has no nvidia-smi, or the probe failed. */
  gpus: MachineGpu[];
  /** Always empty. Kept so SPAs still awaiting their OTA update, which map it, keep rendering. */
  liveRuns: never[];
  /** ISO timestamp of the successful probe; null when no probe ran or it failed. */
  probedAt: string | null;
  /** Human-readable probe failure reason; null when the probe succeeded or was skipped. */
  probeError: string | null;
}

// ── environments.list / get / validate / save / delete ──────────────────────
// The execution environments under config/environments/*.json. `body` is the raw file content (not
// the resolved definition), so `file:` prompt refs survive an edit round-trip. Environment files
// hold no secrets; the full body is safe to expose.

/** 'stock' = byte-identical to the shipped default, 'modified' = a shipped name that differs,
 *  'custom' = no shipped default of that name. */
export type EnvironmentOrigin = 'stock' | 'modified' | 'custom';

export interface EnvironmentEntry {
  /** Basename without .json extension. */
  name: string;
  /** Top-level `description` field from the file; null if absent. */
  description: string | null;
  /** Full parsed JSON body; null when the file cannot be parsed. */
  body: Record<string, unknown> | null;
  /** False when the validator reports blocking errors — the row is flagged in the list. */
  valid: boolean;
  /** Count of blocking errors; 0 when valid. */
  errorCount: number;
  /** Relationship to the shipped defaults. Defaults are copy-if-missing and never overwrite, so
   *  editing a `stock` environment forks it from upstream permanently. */
  origin: EnvironmentOrigin;
}

export interface EnvironmentIssue {
  /** Field anchor, e.g. `pluginDirs[0]`. */
  path: string;
  message: string;
}

export interface EnvironmentDetail {
  name: string;
  description: string | null;
  body: Record<string, unknown> | null;
  /** Absolute path of the backing file. */
  filePath: string;
  origin: EnvironmentOrigin;
  /** Hash of the bytes on disk — pass back as `baseHash` on save to detect a concurrent edit. */
  sha256: string;
  errors: EnvironmentIssue[];
  warnings: EnvironmentIssue[];
}

export interface EnvironmentsValidateReturn {
  ok: boolean;
  errors: EnvironmentIssue[];
  warnings: EnvironmentIssue[];
}

export interface EnvironmentsSaveReturn {
  changed: boolean;
  sha256: string;
  warnings: EnvironmentIssue[];
}

export interface EnvironmentsDeleteReturn {
  removed: boolean;
}

// ── skills.list DTO (plan §12 A item 2 / 8a) ────────────────────────────────
// One group per catalog plugin that offers valid skills, from domain/plugins/catalog.ts
// listSkillGroups(). Skills within each group are sorted alphabetically.

export interface SkillGroup {
  /** Plugin id (e.g. 'cortex-common'). */
  plugin: string;
  /** Sorted list of skill names in this group */
  skills: string[];
}

// ── plugins.list / plugins.assign DTOs ──────────────────────────────────────
// Sanitized plugin catalog view plus the editable assignment targets exposed by ui-service.

export interface UiPluginCatalogIssue {
  code: string;
  scope: 'plugin' | 'manifest' | 'skill' | 'mcp' | 'server';
  path: string | null;
  message: string;
}

export interface UiPluginManifest {
  source: 'root' | 'legacy' | 'none';
  name?: string;
  schema?: string;
  version?: string;
  description?: string;
}

export interface UiPluginSkill {
  name: string;
  /** Frontmatter description, '' when a legacy skill has none. */
  description: string;
  /** True when Cortex ships this skill. plugin-sync overwrites every shipped file on the next
   *  version bump, so an edit here is temporary — the UI has to say so before the edit is made. */
  managed: boolean;
}

export interface UiPluginMcpStdioSummary {
  command: string;
  argsCount: number;
  envKeys: string[];
}

export interface UiPluginMcpRemoteSummary {
  origin: string;
  headerKeys: string[];
}

export type UiPluginMcpServer =
  | { name: string; type: 'stdio'; summary: UiPluginMcpStdioSummary }
  | { name: string; type: 'streamable-http' | 'sse'; summary: UiPluginMcpRemoteSummary };

export interface UiPluginCatalogEntry {
  id: string;
  kind: 'portable' | 'legacy' | 'unknown';
  /** Whether spawn-time filtering restricts this plugin to some sessions. 'always' means assignment
   *  is the only gate; 'commission' and 'channel' mirror filterScopedPlugins. */
  scope: 'always' | 'commission' | 'channel';
  /** Channel prefix a 'channel'-scoped plugin requires, e.g. 'feishu:'. */
  scopePrefix?: string;
  /** 'managed' when Cortex ships this plugin id, so plugin-sync owns its shipped files and can
   *  refresh them; 'local' when it exists only on this machine and nothing will ever rewrite it. */
  origin: 'managed' | 'local';
  rootDir: string;
  valid: boolean;
  assignable: boolean;
  manifest: UiPluginManifest;
  skills: UiPluginSkill[];
  mcp: { status: 'missing' | 'valid' | 'invalid'; servers: UiPluginMcpServer[] };
  issues: UiPluginCatalogIssue[];
}

export interface PluginAgentTarget {
  kind: 'agent';
  name: string;
  editable: true;
  baseHash: string;
  managedPluginIds: string[];
  unmanagedPluginCount: number;
}

export type PluginAssignmentTarget = PluginAgentTarget;

export interface PluginsListReturn {
  plugins: UiPluginCatalogEntry[];
  targets: PluginAssignmentTarget[];
}

export interface PluginsAssignReturn {
  changed: boolean;
  baseHash: string;
}

// ── plugin authoring DTOs ───────────────────────────────────────────────────
// The write side of the plugin catalog: SKILL.md editing, skill and plugin lifecycle, and the
// MCP server form. Every op names its plugin by catalog id; the server re-resolves the path.

export interface PluginsSkillFile {
  pluginId: string;
  skill: string;
  /** Plugins-root-relative path, for display only. */
  path: string;
  content: string;
  /** Shipped by Cortex: an edit here is reverted at the next plugin version bump. */
  managed: boolean;
  baseHash: string;
}

/** One MCP server as the editor needs it. Unlike the catalog summary this carries the real command,
 *  args, cwd and url — a form cannot round-trip a value it never received. Secrets stay behind:
 *  env and header VALUES are never sent, only their key names. */
export type UiPluginMcpDraft =
  | { name: string; type: 'stdio'; command: string; args: string[]; cwd?: string; envKeys: string[] }
  | { name: string; type: 'streamable-http' | 'sse'; url: string; headerKeys: string[] };

export interface PluginsMcpRead {
  pluginId: string;
  /** False when the plugin is legacy, where mcp.json is never loaded however it is written. */
  supported: boolean;
  servers: UiPluginMcpDraft[];
}

/** Secret maps are patches, not replacements: `null` keeps whatever is on disk under that key, a
 *  string sets a new value, and an omitted key is dropped. That is what lets the browser edit a
 *  server without ever having been told its current token. */
export interface PluginsMcpServerInput {
  name: string;
  type: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
}

export interface PluginsSkillWriteReturn {
  baseHash: string;
}

export interface PluginsSkillReturn {
  pluginId: string;
  skill: string;
}

export interface PluginsPackageReturn {
  id: string;
}

// ── memory read-only fs DTOs (DR-0018 §6 Stage-6 memory viewer 7b) ─────────
// A project's memory tree: top-level files + memory dirs with entry counts. Read-only;
// the underlying handler restricts all paths to the project root under PROJECTS_DIR.

export interface MemoryFileEntry {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface MemoryDirEntry {
  name: string;
  /** Number of `*.md` entry files, excluding the auto-generated `index.md` and `AGENTS.md`. */
  entryCount: number;
  /**
   * The dir's `*.md` entry files (same filter as `entryCount` — excludes `index.md` / `AGENTS.md`),
   * sorted by name. Lets a client enumerate + open the files under each memory dir (mobile 1j
   * accordion) without a second round-trip. `entryCount === entries.length`.
   */
  entries: MemoryFileEntry[];
}

export interface MemoryTree {
  projectId: string;
  files: MemoryFileEntry[];
  dirs: MemoryDirEntry[];
}

/** Real per-file line-level diff counts vs HEAD (`git diff --numstat`). */
export interface MemoryLineDiff {
  added: number;
  removed: number;
}

/** Real per-line `git blame` attribution for one line of a memory file. */
export interface MemoryBlameLine {
  /** 1-based line number, aligned 1:1 with the file's content lines. */
  line: number;
  /** Short commit hash (8 hex) that last touched this line, from `git blame`. */
  commit: string;
  /**
   * Task reference parsed from that commit's subject (a 4-hex id after a `task`/`manager`/`gate`
   * keyword). `null` (honest placeholder, never fabricated) when the subject carries no such tag.
   */
  taskRef: string | null;
}

export interface MemoryFile {
  projectId: string;
  /** Project-root-relative path echoed back. */
  path: string;
  content: string;
  sizeBytes: number;
  modifiedAt: string;
  /**
   * Working-tree-vs-HEAD line counts from `git diff --numstat`. `null` (honest placeholder, never
   * fabricated) when the project dir is not in a git work tree, git is unavailable, or the diff is
   * binary/unresolvable.
   */
  lineDiff: MemoryLineDiff | null;
  /**
   * Per-line `git blame` attribution (real commit hash + parsed task ref), aligned 1:1 with the
   * content lines. `null` (honest placeholder, never fabricated) when the project dir is not a git
   * work tree, git is unavailable, or the file is binary/unblameable.
   */
  blame: MemoryBlameLine[] | null;
}

// ── approvals DTO (DR-0018 §2.1 approval center 7a) ────────────────
// Parsed from <CORTEX_HOME>/context/PENDING_APPROVALS.md. One entry per `## <date> <title>`
// heading. The queue is a markdown store; approve/reject only flip the Status line (no execution).

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export interface ApprovalInfo {
  /** Stable id derived from the heading line (no explicit id exists in the markdown). */
  id: string;
  title: string;
  /**
   * Owning project from the `- **Project**:` bullet (need-approval skill template). `null` (honest
   * placeholder, never fabricated) for legacy entries and system-level operations — the UI renders
   * those as "global".
   */
  projectId: string | null;
  operation: string | null;
  reason: string | null;
  impact: string | null;
  /** From the `Command/Action` bullet. */
  command: string | null;
  status: ApprovalStatus;
  /** Date from the `## <YYYY-MM-DD> <title>` heading, null if unparseable. */
  queuedAt: string | null;
  /** Timestamp parsed from an approved/rejected Status line, null otherwise. */
  decidedAt: string | null;
  /** Parenthetical feedback captured from a rejected Status line, null otherwise. */
  feedback: string | null;
  /**
   * Verbatim `Provenance` bullet — the only real "who raised this / origin" carrier in the queue
   * (§12 C item 13). Project attribution now has its own structured `Project` bullet (projectId),
   * but origin/from remains this freeform bullet only a subset of entries add. `null` (honest
   * placeholder, never fabricated) when absent. Backs the approval-center origin/from slots.
   */
  provenance: string | null;
  /**
   * 4-hex task/manager/gate ref parsed from `provenance` (parseTaskRef semantics, shared with
   * memory blame). `null` (honest placeholder, never fabricated) when the provenance bullet is
   * absent or carries no anchored ref. Backs the approval-center `task` slot.
   * NOTE: the prototype's `ttl` slot has ZERO source (the markdown queue has no expiry concept) →
   * deliberately NOT a DTO field, never fabricated.
   */
  taskRef: string | null;
}

// ── issues DTO (design sec-24 project issue list) ──────────────────
// Parsed from the per-project <contextDir>/ISSUES.md. One entry per column-0 `- **<title>**`
// bullet; the real files carry freeform sub-bullets (问题/发生时机/调查过程/建议/规避/Fix…), NOT a
// guaranteed schema. No status field exists — being listed == pending (design sec-24). The design
// mock's source (`nightly-eval › report`) and 相关文件 chips have NO markdown source → deliberately
// NOT DTO fields, never fabricated.

export interface IssueInfo {
  /** Stable id derived from the raw title line (no explicit id exists in the markdown). */
  id: string;
  /** Bold title text of the entry bullet. */
  title: string;
  /** First `YYYY-MM-DD` found in the title line's trailing parens; honest null when absent. */
  date: string | null;
  /** Raw markdown body lines (freeform sub-bullets), verbatim; '' when the entry has no body. */
  body: string;
}

// User-private project note. It is served to operator UIs only and never injected into agent context.
export type NoteInfo = ProjectNote;

// ── system.daemonStatus DTO ───────────────────────────────────────
// Daemon + child (app.js) process status. Read from daemon.pid / daemon-child.pid
// under STORE_DIR; liveness checked via process.kill(pid, 0); uptime from /proc.
// All nullable fields are honest (no /proc on non-Linux, stale PID, etc.).
// The rebuild record is the supervisor's own publication (core/rebuild-progress.ts) — this layer
// renames it for the UI but does not restate its shape, so the two cannot drift.

import type {
  RebuildProgress as DaemonRebuildProgress,
  RebuildStepState as DaemonRebuildStep,
  RebuildStepName as DaemonRebuildStepName,
  RebuildStepStatus as DaemonRebuildStepStatus,
  RebuildStatus as DaemonRebuildStatus,
} from '@core/rebuild-progress.js';

export type {
  DaemonRebuildProgress, DaemonRebuildStep, DaemonRebuildStepName,
  DaemonRebuildStepStatus, DaemonRebuildStatus,
};

export interface DaemonProcessInfo {
  name: string;
  label: string;
  status: 'running' | 'stopped' | 'unknown';
  pid: number | null;
  uptime: string | null;
  port: number | null;
}

export interface SystemDaemonStatus {
  processes: DaemonProcessInfo[];
  lastRestart: { at: string | null };
  /** The supervisor's hot-rebuild pipeline: the run in flight, or the last one it finished. Null
   *  when no rebuild has run (production installs never rebuild) or when the record belongs to a
   *  supervisor that is no longer alive. */
  rebuild: DaemonRebuildProgress | null;
}

// ── system.notices DTO ────────────────────────────────────────────

export interface SystemNoticeEntry {
  id: string;
  ts: string;
  level: 'info' | 'warning' | 'error';
  title?: string;
  text: string;
}

export interface SystemNotices {
  entries: SystemNoticeEntry[];
  /** Ring buffer capacity, so the UI can label "showing N of cap" honestly. */
  cap: number;
}

// ── system.rateLimitStatus DTO ────────────────────────────────────

export interface RateLimitWindowInfo {
  type: string;
  label?: string;
  utilization: number | null;
  resetsAt: number;
  activatedAt: number;
}

export interface RateLimitProviderInfo {
  provider: string;
  displayName: string;
  waitingSessions: number;
  windows: RateLimitWindowInfo[];
}

export interface SystemRateLimitStatus {
  providers: RateLimitProviderInfo[];
}

// ── system usage DTOs ─────────────────────────────────────────────

export type SystemUsageStatus = ProviderUsage[];
export type SystemRefreshUsageReturn = ProviderUsage[];

// ── system.restart DTO ────────────────────────────────────────────

export interface SystemRestartReturn {
  ok: boolean;
  message: string;
}

// ── server self-update DTOs ───────────────────────────────────────
// Mirrors domain/system/update-ui-state.ts. One npm self-update prompt is raised as a SPA dialog
// (system.updateStatus + apply/skip) and, after a fallback delay, also as a chat message.

export type SystemUpdateStatus = ServerUpdateStatus;

export interface SystemUpdateDecisionReturn {
  /** false when no prompt was pending — a stale dialog whose answer arrived too late. */
  accepted: boolean;
  status: SystemUpdateStatus;
}

// ── system.clearRateLimit DTO ────────────────────────────────────

export interface SystemClearRateLimitReturn {
  /** Providers whose throttle was lifted early. */
  cleared: {
    provider: string;
    displayName: string;
    /** Window types cleared (e.g. five_hour / outage). */
    types: string[];
    /** Latest resetsAt among the cleared windows (epoch sec). */
    resetsAt: number;
  }[];
}

// ── Mutate return types ───────────────────────────────────────────

export interface ProjectCreateReturn {
  /** The id of the newly created project (equals its directory name). */
  id: string;
}

export interface SessionsCreateReturn {
  /** The id of the newly created direct session. */
  sessionId: string;
}

export interface SessionsSendReturn {
  /** The message was accepted and routed. Assistant output returns via the `session.message`
   *  stream event, NOT this return (fire-and-forget). */
  accepted: boolean;
  /** Server clock at acceptance, taken BEFORE the message is routed — so every timestamp the
   *  message later carries (history row, pending injection record) is at or after it. A client
   *  whose own clock differs from the server's uses this to order its optimistic row against
   *  server-written rows instead of trusting the browser clock. */
  acceptedAt: string;
}

export interface SessionsCancelReturn {
  /** True when at least one running execution on the session's channel was cancelled. */
  cancelled: boolean;
  /** How many live executions were cancelled on the session's channel. */
  count: number;
}

export interface SessionsCompactReturn {
  status: 'compacted' | 'not-needed';
  contextUsage: SessionContextUsage | null;
}

export interface SessionsSetProfileReturn {
  /** The profile now active on the session. */
  profileName: string;
  /** True when the switch moved to a different backend (only possible on a session with no history). */
  backendChanged: boolean;
}

export interface SessionsSetAgentReturn {
  /** The agent now selected for the session; null when it follows the global default again. */
  agentName: string | null;
  /** The profile that agent will run under — its own when it pins one, the channel's otherwise.
   *  For display: the switch never writes the channel's profile. */
  profileName: string;
  /** True when the switch moved to a different backend (only possible on a session with no history). */
  backendChanged: boolean;
}

/** What the session will run on its next turn, after the change — effective values, so the client
 *  can render the chip without re-deriving the profile/override layering. */
export interface SessionsSetSelectionReturn {
  profileName: string;
  backend: Backend;
  model: string;
  provider: string | null;
  thinking: string | null;
  /** The gateway route the next turn bills to. */
  mode: string;
  /** The fields that came from the selection rather than from the profile. Null when the session
   *  runs its profile as declared. */
  override: SessionSelectionOverride | null;
  backendChanged: boolean;
}

export interface SessionsCreateAndSendReturn {
  /** The id of the newly created session (the client transitions from draft to this session). */
  sessionId: string;
  /** Server clock at acceptance — see `SessionsSendReturn.acceptedAt`. */
  acceptedAt: string;
}

export interface ExecutionsCancelReturn {
  cancelled: boolean;
}

export interface WaitpointsCancelReturn {
  cancelled: boolean;
  /** The state that blocked the cancel when `cancelled` is false (already fired/expired/cancelled). */
  state: string | null;
}

export interface ConfigSetReturn {
  written: true;
  section: 'budget' | 'profiles' | 'settings' | 'preferences';
}

export interface ConfigSetProviderRateLimitPolicyReturn {
  written: true;
  policy: ProviderRateLimitPolicy;
}

export interface ApprovalMutateReturn {
  id: string;
  status: ApprovalStatus;
}

export interface IssuesDeleteReturn {
  id: string;
  deleted: true;
}

export interface IssuesHandleReturn {
  /** The freshly created direct session now carrying the issue as its first user turn. */
  sessionId: string;
}

export interface NotesDeleteReturn {
  id: string;
  deleted: true;
}

export interface NotesClearCompletedReturn {
  cleared: number;
}

export interface ApprovalsRequestReturn {
  queued: true;
  /** headingId of the newly appended PENDING entry (stable, hashed from the heading line). */
  id: string;
}

// ── Mapped types ──────────────────────────────────────────────────

/** Query params are exactly what the scope's zod schema parses to. */
export type QueryParamMap = { [S in QueryScope]: z.output<QueryInputSchemas[S]> };

export interface QueryReturnMap {
  'projects.list': ProjectConduitInfo[];
  'sessions.list': SessionInfo[];
  'sessions.transcript': SessionTranscript;
  'sessions.subagentTranscript': SessionSubagentTranscript;
  'sessions.debugDetails': TranscriptDebugDetails | null;
  'sessions.pendingInteraction': SessionsPendingInteraction;
  'schedules.list': ScheduleInfo[];
  'commissions.list': CommissionInfo[];
  'commissions.get': CommissionInfo;
  'commissions.decisions': CommissionDecisionEntry[];
  'executions.list': ExecutionInfo[];
  'waitpoints.list': WaitpointInfo[];
  'executions.get': ExecutionDetailInfo;
  'memory.tree': MemoryTree;
  'memory.file': MemoryFile;
  'approvals.list': ApprovalInfo[];
  'issues.list': IssueInfo[];
  'notes.list': NoteInfo[];
  'cost.summary': CostSummary;
  'config.get': ConfigSnapshot;
  'auth.status': AuthStatusSnapshot;
  'auth.flowState': LoginFlowState | null;
  'auth.customProviders': CustomProviderView[];
  'models.catalog': ModelCatalogSnapshot;
  'hooks.list': HooksOverview;
  'machines.list': MachineInfo[];
  'machines.detail': MachineDetail;
  'skills.list': SkillGroup[];
  'plugins.list': PluginsListReturn;
  'plugins.skillFile': PluginsSkillFile;
  'plugins.mcpRead': PluginsMcpRead;
  'environments.list': EnvironmentEntry[];
  'environments.get': EnvironmentDetail;
  'system.daemonStatus': SystemDaemonStatus;
  'system.rateLimitStatus': SystemRateLimitStatus;
  'system.usageStatus': SystemUsageStatus;
  'system.notices': SystemNotices;
  'system.updateStatus': SystemUpdateStatus;
}

/** Mutate args are exactly what the op's zod schema parses to. */
export type MutateArgsMap = { [O in MutateOp]: z.output<MutateInputSchemas[O]> };

export interface MutateReturnMap {
  'projects.create': ProjectCreateReturn;
  'sessions.create': SessionsCreateReturn;
  'sessions.send': SessionsSendReturn;
  'sessions.cancel': SessionsCancelReturn;
  'sessions.compact': SessionsCompactReturn;
  'sessions.setProfile': SessionsSetProfileReturn;
  'sessions.setAgent': SessionsSetAgentReturn;
  'sessions.setSelection': SessionsSetSelectionReturn;
  'sessions.setCommission': SessionsSetCommissionReturn;
  'sessions.createAndSend': SessionsCreateAndSendReturn;
  'sessions.setStarred': SessionsSetStarredReturn;
  'sessions.rename': SessionsRenameReturn;
  'sessions.markRead': void;
  'sessions.markManyRead': SessionsMarkManyReadReturn;
  'sessions.answerQuestion': SessionsInteractionMutateReturn;
  'sessions.respondPlan': SessionsInteractionMutateReturn;
  'sessions.respondDecision': SessionsRespondDecisionReturn;
  'sessions.cancelResume': SessionsCancelResumeReturn;
  'sessions.rewind': SessionsRewindReturn;
  'executions.cancel': ExecutionsCancelReturn;
  'waitpoints.cancel': WaitpointsCancelReturn;
  'schedules.pause': void;
  'schedules.resume': void;
  'schedules.remove': void;
  'schedules.add': ScheduleInfo;
  'schedules.update': ScheduleInfo;
  'commissions.close': CommissionInfo;
  'approvals.approve': ApprovalMutateReturn;
  'approvals.reject': ApprovalMutateReturn;
  'approvals.request': ApprovalsRequestReturn;
  'issues.handle': IssuesHandleReturn;
  'issues.delete': IssuesDeleteReturn;
  'notes.add': NoteInfo;
  'notes.update': NoteInfo;
  'notes.setCompleted': NoteInfo;
  'notes.delete': NotesDeleteReturn;
  'notes.clearCompleted': NotesClearCompletedReturn;
  'config.set': ConfigSetReturn;
  'config.setPlatform': { written: true; restartRequired: true };
  'config.setProviderRateLimitPolicy': ConfigSetProviderRateLimitPolicyReturn;
  'auth.startLogin': LoginFlowState;
  'auth.respondPrompt': LoginFlowState;
  'auth.cancelFlow': LoginFlowState;
  'auth.logout': AuthLogoutReturn;
  'auth.syncGateway': AuthSyncGatewayReturn;
  'auth.upsertCustomProvider': CustomProviderView;
  'auth.removeCustomProvider': AuthRemoveCustomProviderReturn;
  'hooks.create': HooksCreateReturn;
  'hooks.update': HooksUpdateReturn;
  'hooks.setEnabled': HooksSetEnabledReturn;
  'hooks.remove': HooksRemoveReturn;
  'hooks.test': HooksTestReturn;
  'profiles.create': ProfilesCreateReturn;
  'profiles.update': ProfilesUpdateReturn;
  'profiles.remove': ProfilesRemoveReturn;
  'plugins.assign': PluginsAssignReturn;
  'plugins.skillWrite': PluginsSkillWriteReturn;
  'plugins.skillCreate': PluginsSkillReturn;
  'plugins.skillMove': PluginsSkillReturn;
  'plugins.skillRemove': PluginsSkillReturn;
  'plugins.create': PluginsPackageReturn;
  'plugins.remove': PluginsPackageReturn;
  'plugins.convertToPortable': PluginsPackageReturn;
  'plugins.mcpWrite': PluginsMcpRead;
  'environments.validate': EnvironmentsValidateReturn;
  'environments.save': EnvironmentsSaveReturn;
  'environments.delete': EnvironmentsDeleteReturn;
  'system.restart': SystemRestartReturn;
  'system.clearRateLimit': SystemClearRateLimitReturn;
  'system.refreshUsage': SystemRefreshUsageReturn;
  'system.checkUpdate': SystemUpdateCheckResult;
  'system.applyUpdate': SystemUpdateDecisionReturn;
  'system.skipUpdate': SystemUpdateDecisionReturn;
}

export type QueryParams<S extends QueryScope> = QueryParamMap[S];
export type QueryReturn<S extends QueryScope> = QueryReturnMap[S];
export type MutateArgs<O extends MutateOp> = MutateArgsMap[O];
export type MutateReturn<O extends MutateOp> = MutateReturnMap[O];

// ── UiService interface ───────────────────────────────────────────

export interface UiService {
  query<S extends QueryScope>(scope: S, params: QueryParams<S>): Promise<Result<QueryReturn<S>>>;
  mutate<O extends MutateOp>(op: O, args: MutateArgs<O>): Promise<Result<MutateReturn<O>>>;
  subscribe(filter: SubscribeFilter): AsyncIterable<UiEvent> & { close(): void };
}

// ── Deps ──────────────────────────────────────────────────────────

export interface UiServiceDeps {
  /** Shared with background timers; bounded discovery, never waits for update consent. */
  checkServerUpdate: () => Promise<SystemUpdateCheckResult>;
  /** Optional seams for deterministic authentication dispatch tests. */
  getAuthStatus?: () => Promise<AuthStatusSnapshot>;
  authLogin?: AuthLoginService;
  logoutAccount?: (input: LogoutAccountInput) => Promise<AuthLogoutResult>;
  /** Re-derives gateway modes and profiles; defaults to the real discovery-backed sync. */
  syncGateway?: (options: { backends?: string[] }) => Promise<AuthSyncGatewayReturn>;
  /** Files custom providers are read from and written to; defaults to the host's own two files. */
  customProviderStores?: CustomProviderStores;
  projectStore: {
    list(): Project[];
    get(id: string): Project | undefined;
    exists(id: string): boolean;
    getDefault(): Project;
    createProject(name: string): CreateProjectResult;
  };
  sessionStore: {
    listByProject(projectId: string): Promise<Session[]>;
    listByOrigin(origin: 'direct' | 'thread' | 'scheduled', projectId?: string): Promise<Session[]>;
    listResumable(projectId?: string): Promise<Session[]>;
    getById(sessionId: string): Promise<Session | null>;
    /** Admission-only liveness touch for fire-and-forget send. Updates lastUsedAt and returns false
     *  when the session is already pending deletion or missing. */
    touchSessionUse(sessionId: string): Promise<boolean>;
    /** Stamp lastReadAt=now (unread tracking; backs `sessions.markRead`). */
    markRead(sessionId: string): Promise<void>;
    /** Atomic metadata-only writes. */
    setStarred(sessionId: string, starred: boolean): Promise<Session | null>;
    rename(sessionId: string, label: string): Promise<Session | null>;
  };
  /** Capability hint for sessions.list; execution revalidates inside orchestration. Narrowed to
   *  the two fields the answer depends on so the list can answer it once per distinct profile
   *  instead of once per row. */
  supportsSessionCompaction: (session: Pick<Session, 'backend' | 'profileName'>) => boolean;
  /** Latest task-list snapshot for a session (in-memory registry). */
  getSessionTodos: (sessionId: string) => TodoSnapshot | null;
  /** Idle-only manual context compaction, injected at the entry layer. */
  compactSession: (opts: { sessionId: string }) => Promise<
    | { ok: true; status: 'compacted' | 'not-needed'; contextUsage: SessionContextUsage | null }
    | { ok: false; reason: 'not-found' | 'unsupported' | 'running' }
  >;
  /** Snapshot of started Cortex-managed children only; native CLI tasks use their own tracker. */
  getSubagentChildStatuses: (sessionId: string) => ReadonlyMap<string, NonNullable<TranscriptSubagentSummary['status']>>;
  /** Backend-independent conversation history — read source for `sessions.transcript` (S4 chat). */
  conversationHistory: {
    getHistory(
      sessionId: string,
      options?: { includeToolDebug?: boolean },
    ): Promise<SessionHistory | null>;
    /** Compact history plus the cursor that makes the next read a delta. */
    getCompactHistoryAt(sessionId: string): Promise<{
      value: import('@store/conversation-history-repo.js').CompactConversationHistory | null;
      cursor: string;
    }>;
    getSubagentHistory(sessionId: string, subagentId: string): Promise<import('@store/conversation-history-repo.js').SubagentConversationHistory>;
    getToolDebugDetails(
      sessionId: string,
      toolRef: string,
    ): Promise<TranscriptDebugDetails | null>;
    /** First user message text — used to title a label-less session in `sessions.list`. */
    getFirstUserText(sessionId: string): Promise<string | null>;
    /** Append-only decision-action line (`sessions.respondDecision`). */
    appendDecisionAction(sessionId: string, opts: { decisionId: string; action: DecisionActionKind; message?: string; ts?: string }): Promise<void>;
  };
  /** Durable active pending-injection snapshot joined into `sessions.transcript`. */
  pendingInjections: {
    listBySession(sessionId: string): Promise<{
      id: string;
      text: string;
      createdAt: string;
      attachments?: AttachmentMeta[];
      systemOrigin?: SystemTurnOrigin;
    }[]>;
  };
  /**
   * Inject a genuine user turn into a session and route it through the agent (S4 chat send).
   * Fire-and-forget: assistant output returns via the `session.message` stream event, not here.
   * Wired in the entry layer (app.ts) to the orchestration send path — kept as an injected
   * callback so the ui-service domain never imports orchestration (layer safety / depcruise).
   */
  sendSessionMessage: (opts: { channel: string; text: string; attachments?: AttachmentMeta[] }) => void;
  /**
   * Cancel every live execution running on a session's channel (S4 chat Stop). Wired in the entry
   * layer to the orchestration channel-cancel path (`cancelChannelRuns`), which kills the live agent
   * handle, preserves the session, and tears the execution down as `cancelled`. Returns the number
   * cancelled. Kept as an injected callback so the ui-service domain never imports orchestration
   * (layer safety / depcruise).
   */
  cancelSessionRun: (opts: { channel: string }) => Promise<number>;
  /** Kill one live execution and tear it down as `cancelled` (Web "Kill run"). Wired to the
   *  orchestration `cancelLiveExecution`. False when no live execution has that id. */
  cancelLiveExecution: (executionId: string) => Promise<boolean>;
  /**
   * Message edit + rewind: roll the session back to `turnIndex` and re-send the edited text
   * (orchestration `rewindWebSession` — ledger rollback + backend backup restore + pooled-CLI
   * close + display-history truncate + resend). Wired in the entry layer (app.ts) so the
   * ui-service domain never imports orchestration.
   */
  rewindSession: (opts: { sessionId: string; channel: string; turnIndex: number; text: string }) => Promise<{ ok: true } | { ok: false; reason: 'running' | 'not-found' }>;
  /**
   * Create a fresh, live user-initiated (origin='direct') session for the workbench and return its
   * id. Injected in the entry layer (app.ts) to the domain `createDirectSession` primitive with the
   * real session/ledger singletons, so the ui-service domain never imports store internals.
   */
  createDirectSession: (opts: { projectId: string; sessionId?: string; profileName?: string | null; agentName?: string | null; selection?: SessionSelectionOverride | null; browser?: { device: string } | null; commission?: { mode: 'new' } | { mode: 'join'; commissionId: string } | null }) => Promise<{ sessionId: string; sessionName: string; channel: string }>;
  /**
   * Convert a scheduled run's session into a normal direct web session before a reply is sent
   * (design 27b: replying adopts the run — it leaves the schedule grouping and becomes a normal
   * conversation; the next fire starts a fresh session). Injected in the entry layer (app.ts) to
   * the domain `adoptScheduledSession` primitive. Returns the adopted channel, or null when the
   * session is unknown.
   */
  adoptScheduledSession: (opts: { sessionId: string }) => Promise<{ channel: string } | null>;
  /**
   * Move files uploaded under a draft upload id to the real session's attachment directory
   * and return updated AttachmentMeta with corrected paths. No-op when draftUploadId is null.
   */
  moveDraftAttachments: (opts: { draftUploadId: string | null; sessionId: string; attachments: AttachmentMeta[] }) => Promise<AttachmentMeta[]>;
  /**
   * Switch the active agent profile for a session's channel under the shared profile-switch rule
   * (same `switchChannelProfile` the Slack/Feishu `!profile` command uses). Wired in the entry layer
   * (app.ts) so the ui-service domain never imports domain/agents. Returns a structured outcome:
   * `ok:false` with `reason` when the profile is unknown or a cross-backend switch is attempted on a
   * session that already has conversation history.
   */
  switchSessionProfile: (opts: { channel: string; name: string }) => Promise<{
    ok: boolean;
    name: string;
    currentBackend: string;
    targetBackend: string;
    backendChanged: boolean;
    reason?: 'unknown-profile' | 'cross-backend-live-session';
  }>;
  /**
   * Switch the agent — the execution environment — a session's channel runs, under the shared
   * agent-switch rule (the same `switchChannelAgent` the Slack/Feishu `!agent` command uses). A
   * null name clears the channel's selection. Wired in the entry layer (app.ts) for the same reason
   * as the profile switch above: the ui-service domain never imports domain/agents.
   */
  switchSessionAgent: (opts: { channel: string; name: string | null }) => Promise<{
    ok: boolean;
    agentName: string | null;
    /** The profile the agent will run under, for display. */
    effectiveProfile: string;
    backendChanged: boolean;
    reason?: 'unknown-agent' | 'cross-backend-live-session';
    currentBackend?: string;
    targetBackend?: string;
  }>;
  /**
   * Apply a session's engine selection (profile and/or model / provider / thinking) under the
   * shared rule — the domain `applyChannelSelection`, wired in the entry layer (app.ts) so the
   * ui-service domain never imports domain/agents. Returns the effective selection, or a structured
   * refusal the handler maps to a Result code.
   */
  applySessionSelection: (opts: {
    channel: string;
    profileName?: string;
    model?: string | null;
    provider?: string | null;
    thinking?: string | null;
    mode?: string | null;
  }) => Promise<{
    ok: boolean;
    backendChanged: boolean;
    /** The channel's selection after the change — or the untouched one when `ok` is false. */
    profileName: string;
    backend: Backend;
    model: string;
    provider: string | null;
    thinking: string | null;
    mode: string;
    override: SessionSelectionOverride | null;
    /** Present only when `ok` is false. */
    reason?: 'unknown-profile' | 'cross-backend-live-session' | 'invalid-thinking' | 'provider-not-supported'
      | 'invalid-mode';
    currentBackend?: string;
    targetBackend?: string;
    allowed?: readonly string[];
  }>;
  /** What a session selected on top of its profile, by channel — the read half of
   *  `applySessionSelection`, used to render `sessions.list`. Injected for the same reason. */
  getChannelSelectionOverride: (channel: string) => SessionSelectionOverride | null;
  /** The last composer pick on this host, which a draft conversation starts from. Injected for the
   *  same reason as the two above. */
  getSelectionDefault: () => ConfigSelectionDefault | null;
  scheduler: {
    list(): Promise<ScheduleTask[]>;
    get(id: string): Promise<ScheduleTask | null>;
    pause(id: string): Promise<ScheduleTask | null>;
    resume(id: string): Promise<ScheduleTask | null>;
    remove(id: string): Promise<boolean>;
    add(spec: ScheduleSpec): Promise<ScheduleTask>;
    update(id: string, patch: SchedulePatch): Promise<ScheduleTask | null>;
  };
  executionRegistry: {
    getExecution(id: string): ExecutionRecord | null;
    getAll(): ExecutionRecord[];
    cancelExecution(id: string): ExecutionRecord | null;
  };
  /** Waitpoint seam (`waitpoints.*` ops and SessionInfo.waitingOn). Injected at the entry layer so
   *  the ui-service domain never reaches into the waitpoint store itself. Only `armed` records are
   *  ever listed — settled ones have already announced themselves in the session transcript. */
  waitpointRegistry: {
    listArmed(): Promise<Waitpoint[]>;
    cancel(id: string): Promise<{ cancelled: boolean; state?: string }>;
  };
  /** Commission registry seam (commissions.* ops). Optional — handlers fall back to the
   *  commissionRepo singleton when absent, so existing fixtures/entry wiring need no change;
   *  tests inject it for determinism. */
  commissionStore?: {
    list(projectId?: string): Promise<CommissionRecord[]>;
    find(id: string): Promise<CommissionRecord | null>;
    update(id: string, fn: (record: CommissionRecord) => void): Promise<CommissionRecord | null>;
  };
  /** Absolute path to PENDING_APPROVALS.md (the approval-center 7a markdown queue). */
  approvalsPath: string;
  /** The one busy answer (core/session-state.ts): sessions.list joins on it rather than
   *  re-deriving "running" from the executions index and the hold registry separately. */
  runningExecutions: SessionStateReader;
  costSummary: (projectId?: string | null) => Promise<CostSummary>;
  /**
   * Registry of connected cortex-client devices (from remote/client-manager) plus the
   * static machine config (from remote/machine-registry getMachineRegistry). Injected at the
   * entry layer so the ui-service domain never imports the remote layer directly.
   * SECURITY: the raw ssh user@host string is NOT surfaced — only sshConfigured:boolean.
   */
  clientRegistry: {
    getOnlineDevices(): Array<{
      device: string;
      platform: string;
      connectedAt: Date;
      lastHeartbeat: Date;
      capabilities: string[];
    }>;
    isDeviceOnline(device: string): boolean;
    getMachineRegistry(): Record<string, {
      cortexPath: string;
      gpuCount: number;
      ssh?: string;
      win?: boolean;
    }>;
    /**
     * Run a read-only shell probe on a connected device and return its stdout (machines.detail).
     * The command is built server-side — callers never forward user input into it.
     */
    probeMachine(device: string, command: string, timeoutMs: number): Promise<string>;
  };
  bus: EventBus;
  adapter: PlatformAdapter;
  /**
   * Return the pending ask-user question group for a channel, if any (web UI pending query).
   * Reads from the in-memory pendingAskUserQuestionGroups Map.
   */
  getPendingAskUser: (channel: string) => { requestId: string; questions: { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean }[]; blocking: boolean } | null;
  /**
   * Return the pending plan approval for a channel, if any (web UI pending query).
   * Reads from the in-memory planApprovals Map.
   */
  getPendingPlan: (channel: string) => { requestId: string; planContent: string; planFilePath: string | null } | null;
  /**
   * Resolve a pending ask-user-question interaction (web UI path). The injected impl (app.ts)
   * looks up the hook group, collects answers, updates the interaction entity, and calls
   * tryResolveHook/resolveHookRequest so the blocked MCP tool receives its response.
   * Three-way outcome: 'resolved' | 'already-resolved' (another client won the race) |
   * 'not-found' (no such interaction).
   */
  answerQuestion: (requestId: string, answers: Record<string, string>) => 'resolved' | 'already-resolved' | 'not-found';
  /**
   * Resolve a pending plan-approval interaction (web UI path). Same three-way outcome as
   * answerQuestion; the impl calls planApprovals.resolve/reject + entity resolve +
   * resolveHookRequest.
   */
  respondPlan: (requestId: string, approved: boolean, feedback?: string) => 'resolved' | 'already-resolved' | 'not-found';
  /**
   * Liveness signal for transcript materialization: true only while the interaction is a live,
   * un-expired pending entry in the in-process index. After a restart the index is empty, so
   * still-`pending` persisted rows derive to `expired` at read time.
   */
  isInteractionPending: (id: string) => boolean;
}
