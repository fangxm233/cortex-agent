// input:  domain types, auth flows, settings, stores
// output: UI DTOs/maps incl plugin and auth ops
// pos:    Canonical transport-neutral UI contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { Project, CreateProjectResult } from '@domain/projects/index.js';
import type { CostSummary } from '@domain/costs/cost-tracker.js';
import type { EventBus } from '@events/index.js';
import type { RunningExecutions } from '@core/running-executions.js';
import type { Settings, SettingSnapshotEntry } from '@core/settings-spec.js';
import type {
  AuthNoticeAction,
  ChatNoticeLevel,
  NoticeAction,
  SessionContextUsage,
} from '@core/types/agent-types.js';
export type {
  AuthNoticeAction,
  ChatNoticeLevel,
  NoticeAction,
  SessionContextUsage,
} from '@core/types/agent-types.js';
import type { PlatformAdapter } from '@platform/adapter.js';
import type {
  HookBackend,
  HookEvent,
  HookFilterValue,
  HookPhase,
  HookResultMode,
  HookSource,
} from '@store/hook-registry.js';
import type { HookApplyTime, HookMountTarget } from '@domain/hooks/hook-view.js';
export type { HookApplyTime, HookMountTarget } from '@domain/hooks/hook-view.js';
import type { Session } from '@store/session-registry-repo.js';
import type { ScheduleTask, ScheduleTarget } from '@store/schedule-repo.js';
import type { LogLocation } from '@domain/executions/log-tailer.js';
import type { SessionHistory } from '@store/conversation-history-repo.js';
import type { Backend } from '../../agent-adapter/types.js';
import type { ProjectNote } from '@store/project-notes-repo.js';
import type {
  AuthLoginService,
  AuthLogoutResult,
  AuthLogoutSuccess,
  AuthStatusSnapshot,
  AuthType,
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
import type {
  CustomProviderApi,
  CustomProviderModelSpec,
  CustomProviderStores,
  CustomProviderView,
} from '@domain/pi-providers/index.js';
export type {
  CustomProviderApi,
  CustomProviderModelSpec,
  CustomProviderView,
} from '@domain/pi-providers/index.js';

// ── Result ────────────────────────────────────────────────────────

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; code: string; message: string };
export type Result<T> = Ok<T> | Err;

// ── Query scopes ──────────────────────────────────────────────────

export type QueryScope =
  | 'projects.list'
  | 'sessions.list'
  | 'sessions.transcript'
  | 'sessions.pendingInteraction'
  | 'threads.list'
  | 'threads.get'
  | 'tasks.list'
  | 'tasks.verification'
  | 'schedules.list'
  | 'executions.list'
  | 'executions.get'
  | 'memory.tree'
  | 'memory.file'
  | 'approvals.list'
  | 'issues.list'
  | 'notes.list'
  | 'cost.summary'
  | 'config.get'
  | 'auth.status'
  | 'auth.flowState'
  | 'auth.customProviders'
  | 'hooks.list'
  | 'machines.list'
  | 'machines.detail'
  | 'skills.list'
  | 'plugins.list'
  | 'threadTemplates.get'
  | 'threadTemplates.detail'
  | 'system.daemonStatus'
  | 'system.rateLimitStatus';

// ── Mutate ops ────────────────────────────────────────────────────

export type MutateOp =
  | 'projects.create'
  | 'sessions.create'
  | 'sessions.send'
  | 'sessions.cancel'
  | 'sessions.compact'
  | 'sessions.setProfile'
  | 'sessions.createAndSend'
  | 'sessions.markRead'
  | 'sessions.answerQuestion'
  | 'sessions.respondPlan'
  | 'sessions.cancelResume'
  | 'sessions.rewind'
  | 'threads.cancel'
  | 'executions.cancel'
  | 'schedules.pause'
  | 'schedules.resume'
  | 'schedules.remove'
  | 'schedules.add'
  | 'schedules.update'
  | 'tasks.claim'
  | 'tasks.unclaim'
  | 'tasks.complete'
  | 'tasks.block'
  | 'tasks.unblock'
  | 'approvals.approve'
  | 'approvals.reject'
  | 'approvals.request'
  | 'issues.handle'
  | 'issues.delete'
  | 'notes.add'
  | 'notes.update'
  | 'notes.setCompleted'
  | 'notes.delete'
  | 'notes.clearCompleted'
  | 'config.set'
  | 'auth.startLogin'
  | 'auth.respondPrompt'
  | 'auth.cancelFlow'
  | 'auth.logout'
  | 'auth.upsertCustomProvider'
  | 'auth.removeCustomProvider'
  | 'hooks.create'
  | 'hooks.update'
  | 'hooks.setEnabled'
  | 'hooks.remove'
  | 'hooks.test'
  | 'profiles.create'
  | 'profiles.update'
  | 'profiles.remove'
  | 'plugins.assign'
  | 'threadTemplates.validate'
  | 'threadTemplates.save'
  | 'threadTemplates.remove'
  | 'system.restart'
  | 'system.clearRateLimit';

// ── Subscribe ─────────────────────────────────────────────────────

export interface SubscribeFilter {
  events: string[];
  projectId?: string | null;
  /** Scope `execution.log` events to a single execution (B2-C live log stream). */
  executionId?: string | null;
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

/** Input for the `executions.log` subscription (B2-C). Parity-guarded in @cortex-agent/ui-contract. */
export interface ExecutionsLogParams {
  executionId: string;
}

// ── Query params / return types ───────────────────────────────────

export interface SessionsListParams {
  projectId?: string;
  resumable?: boolean;
  /** Restrict to a single initiation origin. The workbench left rail passes 'direct' so
   *  only user conversations show; thread/scheduled sessions live in their own views. */
  origin?: 'direct' | 'thread' | 'scheduled';
}

export interface SessionsTranscriptParams {
  sessionId: string;
}

export interface SessionsPendingInteractionParams {
  sessionId: string;
}

export interface SessionsPendingInteraction {
  askUser: { requestId: string; questions: { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean }[] } | null;
  plan: { requestId: string; planContent: string; planFilePath: string | null } | null;
}

export interface ThreadsListParams {
  projectId?: string;
  status?: string[];
  /** Scope to the threads owned by a single chat session: the handler resolves this session's
   *  channel and returns only threads running on it (a thread spawned interactively runs on its
   *  originating channel). Backs the inline chat thread card, which must show THIS conversation's
   *  thread, not a random global one. Unknown session → empty. Omit for the unscoped list. */
  sessionId?: string;
}

export interface ThreadsGetParams {
  threadId: string;
  /** Include artifact.md text for the open detail modal; omitted for lightweight cards. */
  includeArtifactContent?: boolean;
}

export interface TasksListParams {
  projectId?: string;
  status?: 'open' | 'done';
  actionable?: boolean;
}

export interface TaskVerificationParams {
  projectId: string;
  taskId: string;
}

export interface SchedulesListParams {
  projectId?: string;
  paused?: boolean;
}

export interface ExecutionsListParams {
  status?: string[];
  limit?: number;
}

export interface ExecutionsGetParams {
  executionId: string;
}

export interface MemoryTreeParams {
  projectId: string;
}

export interface MemoryFileParams {
  projectId: string;
  /** Path relative to the project root. Absolute paths / `..` traversal / symlink escape are rejected. */
  path: string;
}

export interface ApprovalsListParams {
  /** Filter to a single approval status. Omitted → all entries. */
  status?: ApprovalStatus;
}

export interface IssuesListParams {
  /** Issues are per-project (`<contextDir>/ISSUES.md`) — the project is required. */
  projectId: string;
}

export interface NotesListParams {
  projectId: string;
}

export interface CostSummaryParams {
  projectId?: string | null;
}

export type ConfigGetParams = Record<string, never>;

export type AuthStatusParams = Record<string, never>;

export interface AuthFlowStateParams {
  flowId: string;
}

export type AuthCustomProvidersParams = Record<string, never>;

export type MachinesListParams = Record<string, never>;

export interface MachineDetailParams {
  /** Machine name as registered in machines.json. */
  machine: string;
}

export type SkillsListParams = Record<string, never>;

export type PluginsListParams = Record<string, never>;

export type ThreadTemplatesGetParams = Record<string, never>;

export type SystemDaemonStatusParams = Record<string, never>;

export type SystemRateLimitStatusParams = Record<string, never>;

// ── Mutate args ───────────────────────────────────────────────────

export interface ProjectCreateArgs {
  name: string;
}

export interface AuthStartLoginArgs {
  backend: 'claude' | 'pi';
  provider: string;
  authType: AuthType;
  noticeId?: string;
}

export interface AuthRespondPromptArgs {
  flowId: string;
  value: string;
}

export interface AuthCancelFlowArgs {
  flowId: string;
}

export type AuthLogoutArgs = LogoutAccountInput;
export type AuthLogoutReturn = AuthLogoutSuccess;

// auth.upsertCustomProvider / auth.removeCustomProvider — the definitions of self-hosted or proxied
// endpoints. The upstream URL and key live in the gateway route, the protocol and models in PI's
// catalog; both files are written from this one draft. `apiKey` omitted keeps the stored key.
export interface AuthUpsertCustomProviderArgs {
  name: string;
  api: CustomProviderApi;
  upstreamUrl: string;
  apiKey?: string;
  models: CustomProviderModelSpec[];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface AuthRemoveCustomProviderArgs {
  name: string;
}

export interface AuthRemoveCustomProviderReturn {
  removed: boolean;
}

export interface SessionsCreateArgs {
  /** Project the new session belongs to. Omitted → the default project (handler fallback). */
  projectId?: string;
}

// ── Attachment metadata (S4 chat file attachments, 15a) ──────────────────
// Describes a file uploaded through the web composer's "+ attach" / paste / drop.
// Files are stored under DATA_DIR/tmp/attachments/<sessionId>/ on the server;
// the message carries paths so the agent can read them directly.

export interface AttachmentMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  type: 'image' | 'video' | 'file';
}

export interface SessionsSendArgs {
  sessionId: string;
  text: string;
  /** Optional file attachments already uploaded to the server. */
  attachments?: AttachmentMeta[];
}

export interface SessionsCancelArgs {
  sessionId: string;
}

export interface SessionsCompactArgs {
  sessionId: string;
}

export interface SessionsMarkReadArgs {
  sessionId: string;
}

export interface SessionsSetProfileArgs {
  sessionId: string;
  /** The profile to switch the session to. Must exist in profiles.json. */
  profileName: string;
}

export interface SessionsAnswerQuestionArgs {
  requestId: string;
  answers: Record<string, string>;
}

export interface SessionsRespondPlanArgs {
  requestId: string;
  approved: boolean;
  feedback?: string;
}

/** Return of sessions.answerQuestion / sessions.respondPlan. 'already-resolved' means another
 *  client (or Slack / timeout) resolved the interaction first — not an error; the caller
 *  refetches the transcript to show the final state. */
export interface SessionsInteractionMutateReturn {
  outcome: 'resolved' | 'already-resolved';
}

/** Args for `sessions.cancelResume`: decline the auto-resume promised when a rate limit
 *  interrupted this session's turn. */
export interface SessionsCancelResumeArgs {
  sessionId: string;
}

/** `cancelled: false` means nothing was queued any more — the window reset and the turn
 *  already resumed. A late click is a no-op, not an error. */
export interface SessionsCancelResumeReturn {
  cancelled: boolean;
}

/** Args for `sessions.rewind` (message edit + rewind, desktop design 23 / mobile 7): replace the
 *  user message that opened `turnIndex` with `text`, rolling back every later turn and
 *  regenerating. Attachments of the original message are preserved server-side (the edit UI can
 *  neither add nor remove them). */
export interface SessionsRewindArgs {
  sessionId: string;
  /** The transcript turn whose opening user message is being edited. */
  turnIndex: number;
  /** The edited message text (non-empty). */
  text: string;
}

/** Fire-and-forget like sessions.send — the regenerated reply streams over `session.message`. */
export interface SessionsRewindReturn {
  accepted: true;
}

export interface SessionsCreateAndSendArgs {
  /** Project the new session belongs to. */
  projectId: string;
  /** The profile to create the session with. Omitted → system default. */
  profileName?: string;
  /** First user message text. */
  text: string;
  /** Optional file attachments. */
  attachments?: AttachmentMeta[];
  /** Temporary upload directory id (draft mode). Attachments were uploaded under this id
   *  rather than a real sessionId. The handler moves them to the new session's dir. */
  draftUploadId?: string;
}

export interface ThreadsCancelArgs {
  threadId: string;
}

export interface ExecutionsCancelArgs {
  executionId: string;
}

export interface ScheduleActionArgs {
  scheduleId: string;
}

// Args for `schedules.add` (DR-0018 §2.1 7c). Per-type required fields are enforced by the zod
// `scheduleAddInput` schema at the router boundary AND re-checked in the handler (so a direct
// facade/unit call is rejected too). intervalMs/delay are raw ms numbers; dayOfWeek is 0..6.
export interface ScheduleAddArgs {
  type: 'interval' | 'daily' | 'weekly' | 'once';
  message: string;
  projectId?: string;
  profile?: string;
  intervalMs?: number;
  time?: string;
  dayOfWeek?: number;
  delay?: number;
  target?: ScheduleTarget;
  fallback?: 'fresh' | 'skip' | 'wait';
}

// Args for `schedules.update` — a partial patch of an existing schedule. The schedule's type is
// immutable; only fields valid for that type are accepted (checked against the persisted task in
// the handler, mirroring scheduler.validateTaskPatch). target/fallback are not patchable in v1.
export interface ScheduleUpdateArgs {
  scheduleId: string;
  message?: string;
  projectId?: string;
  profile?: string;
  intervalMs?: number;
  time?: string;
  dayOfWeek?: number;
}

export interface TaskActionArgs {
  projectId: string;
  taskId: string;
}

export interface TaskCompleteArgs extends TaskActionArgs {
  note?: string;
}

export interface TaskBlockArgs extends TaskActionArgs {
  reason: string;
}

// Safely-writable config.set sections (Stage 7 + task b983). Each section has its own validated
// write path; any section not listed here is rejected by both the zod schema and the handler.
// `budget` writes budget.json (daily/monthly); `profiles` re-points the default profile (which must
// already exist in profiles.json — the write can only SELECT an existing profile, never invent one).
export interface BudgetValue {
  daily_usd: number;
  monthly_usd: number;
}

export interface ProfilesValue {
  defaultProfile: string;
}

export type SettingsValue = Partial<Settings>;

/**
 * `project` absent/null targets the global limits; a project id targets that project's override.
 * An absent/null `value` clears an override (legal only together with a `project`) — per-project
 * overrides are pair-only, so a project either declares both limits or inherits both globals.
 */
export interface ConfigSetBudgetArgs {
  section: 'budget';
  project?: string | null;
  value?: BudgetValue | null;
}

export type ConfigSetArgs =
  | ConfigSetBudgetArgs
  | { section: 'profiles'; value: ProfilesValue }
  | { section: 'settings'; value: SettingsValue };

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
  claudeBackend?: 'print' | 'tui';
  extraOption?: Record<string, string>;
}

export interface ProfilesCreateArgs extends ProfileDraftInput {
  name: string;
}
export interface ProfilesCreateReturn {
  name: string;
}

export interface ProfilesUpdateArgs extends ProfileDraftInput {
  name: string;
}
export interface ProfilesUpdateReturn {
  changed: boolean;
}

export interface ProfilesRemoveArgs {
  name: string;
}
export interface ProfilesRemoveReturn {
  removed: boolean;
}

export interface ApprovalsApproveArgs {
  id: string;
}

// issues.handle / issues.delete both take the target issue off the project's ISSUES.md list
// (design sec-24: 在列表即待处理，处理/删除即离场).
export interface IssueActionArgs {
  projectId: string;
  id: string;
}

export interface NoteAddArgs {
  projectId: string;
  text: string;
}

export interface NoteUpdateArgs extends NoteAddArgs {
  id: string;
}

export interface NoteSetCompletedArgs {
  projectId: string;
  id: string;
  completed: boolean;
}

export interface NoteActionArgs {
  projectId: string;
  id: string;
}

export interface NotesClearCompletedArgs {
  projectId: string;
}

export interface ApprovalsRejectArgs {
  id: string;
  feedback?: string;
}

// approvals.request enqueues a high-privilege operation as a PENDING entry in
// PENDING_APPROVALS.md instead of executing it (task b983 — the Web settings "approval gate").
// The `kind` is a CLOSED enum and the server constructs ALL of the entry's prose; the browser
// cannot inject arbitrary markdown. Never runs the operation — a human/agent actions it after
// approval (mirrors approvals.approve, which also only flips the Status line).
export interface ApprovalsRequestArgs {
  kind: 'reconnect-platform' | 'add-machine';
  /** Required when kind === 'reconnect-platform'. */
  platform?: 'slack' | 'feishu';
  /** Required when kind === 'add-machine'. */
  machineName?: string;
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
  createdAt: string;
  lastUsedAt: string;
  resumable: boolean;
  label: string | null;
  /** The session's active agent profile (registry record). Null when never explicitly set — the
   *  client falls back to the config default. Kept in sync by the shared profile-switch rule. */
  profileName: string | null;
  /** Latest backend context occupancy, or null until a supported backend reports one. Optional only
   *  for rolling compatibility with older servers/fixtures; current sessions.list always supplies it. */
  contextUsage?: SessionContextUsage | null;
  /** True only for PI and Claude print sessions under their fixed profile. */
  contextCompactionSupported?: boolean;
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

export interface TranscriptInteractionDetail {
  id: string;
  kind: InteractionKind;
  status: InteractionStatus;
  payload: {
    questions?: InteractionQuestion[];
    /** Severity of an ask-user card ('info'|'warning'|'error') — absent = neutral look. */
    level?: ChatNoticeLevel;
    planContent?: string;
    planFilePath?: string | null;
  };
  result?: { answers?: Record<string, string>; feedback?: string };
  resolvedVia?: string;
}

export interface TranscriptDebugDetails {
  /** Exact message sent to the agent for a user turn. */
  agentMessage?: string;
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
  /** File attachments: user uploads via the web composer (15a, user messages) OR agent-sent
   *  files via the `send_file` MCP tool (20a, assistant messages). */
  attachments?: AttachmentMeta[];
  /** Present on a user message that replaced an earlier one via edit+rewind (sessions.rewind):
   *  the original text/ts backing the「已编辑」badge + hover/tap original-message card. */
  edited?: { originalText: string; originalTs: string };
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
}

export interface SessionTranscript {
  sessionId: string;
  turns: TranscriptTurn[];
  /** Durable messages accepted into a live backend turn but not consumed by the model yet.
   *  Optional for rolling compatibility with older servers; current servers always return it. */
  pendingUserMessages?: PendingTranscriptUserMessage[];
}

export interface ThreadInfo {
  id: string;
  templateName: string;
  currentStep: { index: number; name: string } | null;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'aborted';
  projectId: string;
  createdAt: string;
  updatedAt: string;
  totalSteps: number;
  artifactPath: string | null;
  /** Optional while Desktop/Mobile clients and servers roll independently. */
  taskId?: string | null;
}

// ── threads.get detail DTO (DR-0018 §6.3 B1) ─────────────────────

export interface ThreadStepDetail {
  stepIndex: number;
  agentSlotId: string;
  stage: string | null;
  status: 'completed' | 'running' | 'pending';
  executionId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationS: number | null;
  startedAt: string | null;
  endedAt: string | null;
  outputSummary: string | null;
}

export interface ThreadAgentFlow {
  slotId: string;
  profile: string;
  status: 'idle' | 'running' | 'completed';
  stage: string | null;
  sessionId: string | null;
  sessionName: string | null;
  lastOutput: string | null;
}

export interface ThreadDispatchInfo {
  executionId: string;
  status: string;
  machine: string | null;
  type: 'local' | 'dispatch';
  agentSlotId: string | null;
  stepIndex: number | null;
  taskId: string | null;
  runName: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  cost: number | null;
}

export interface ThreadChildNode {
  id: string;
  templateName: string | null;
  status: ThreadInfo['status'];
  activeAgent: string | null;
  costUsd: number;
  depth: number;
  createdAt: string;
  taskId: string | null;
  children: ThreadChildNode[];
  truncated: boolean;
}

export interface ThreadArtifactRefs {
  artifactPath: string | null;
  workspacePath: string | null;
  taskId: string | null;
  taskProject: string | null;
  /** Present only when threads.get requested artifact content; null on no file/read failure. */
  content?: string | null;
}

export interface ThreadSubtaskInfo {
  id: string;
  text: string;
  status: 'open' | 'done';
  actionable: boolean;
  claimedBy: string | null;
  blockedBy: string | null;
}

export interface ThreadDetail {
  id: string;
  templateName: string;
  currentStep: { index: number; name: string } | null;
  status: ThreadInfo['status'];
  projectId: string;
  createdAt: string;
  updatedAt: string;
  totalSteps: number;
  artifactPath: string | null;
  endedAt: string | null;
  error: string | null;
  abortReason: string | null;
  activeAgent: string | null;
  activeStage: string | null;
  totalCostUsd: number;
  steps: ThreadStepDetail[];
  agentFlow: ThreadAgentFlow | null;
  dispatches: ThreadDispatchInfo[];
  subtasks: ThreadSubtaskInfo[];
  children: ThreadChildNode[];
  artifacts: ThreadArtifactRefs;
}

export interface TaskInfo {
  id: string;
  text: string;
  project: string;
  status: 'open' | 'done';
  priority: 'high' | 'medium' | 'low';
  actionable: boolean;
  claimedBy: string | null;
  /** Owning task-dispatch thread; optional while app and server versions roll independently. */
  claimThreadId?: string | null;
  blockedBy: string | null;
  /** Approval gate from task-store `approval-needed`; absent only with an older server contract. */
  approvalNeeded?: boolean;
  /** Recorded approval date; absent only with an older server contract. */
  approvedAt?: string | null;
  dependsOn: string[];
  /** Unresolved dependencies across all projects; optional with an older server contract. */
  unmetDependencyIds?: string[];
  plan: string | null;
  template: string;
  /** The task's rationale (task store `why`). Null when absent/empty (null-safe). */
  why: string | null;
  /** The task's completion criteria (task store `done-when`). Null when absent/empty (null-safe). */
  doneWhen: string | null;
  /** Completion timestamp; optional while app and server versions roll independently. */
  completedAt?: string | null;
}

// ── tasks.verification DTO (DR-0018 §12 C item 11) ────────────────
// Single-task done-when EVIDENCE + per-task dispatch history. DEEPER than TaskInfo.doneWhen (which
// is just the criteria text): this joins the REAL completion sources — the task store's
// `completed-note` / `completed-at` / status, plus the terminal execution that completed the task
// (its finalOutput) — and the full per-task execution/dispatch join by taskId. Every field with no
// structured source is an honest `null` / `[]`, never fabricated.

/** Done-when achievement evidence drawn from real completion sources (task store + completing execution). */
export interface TaskDoneWhenEvidence {
  /** Echo of the criteria text (task store `done-when`); null when absent/empty. */
  doneWhen: string | null;
  /** Whether the task reached `done`. */
  completed: boolean;
  /** Real `completed-at` timestamp; null (honest) when the task is not completed / never recorded. */
  completedAt: string | null;
  /** Real `completed-note` — the achievement note captured at completion; null (honest) when absent. */
  completedNote: string | null;
  /** The most-recent TERMINAL execution joined by taskId that completed this task; null when none. */
  completingExecutionId: string | null;
  /** That execution's final output (real evidence of what the run produced); null when unavailable. */
  completingOutput: string | null;
}

/** One execution/dispatch record joined to the task by `dispatch.taskId`. */
export interface TaskDispatchRecord {
  executionId: string;
  type: 'local' | 'dispatch';
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
  machine: string | null;
  threadId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  cost: number | null;
}

export interface TaskVerificationInfo {
  taskId: string;
  project: string;
  evidence: TaskDoneWhenEvidence;
  /** Per-task execution/dispatch history, newest first. `[]` (honest) when never dispatched. */
  dispatches: TaskDispatchRecord[];
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
  /** Persisted dispatch target / fallback; null when the record predates them (never fabricated). */
  target: ScheduleTarget | null;
  fallback: 'fresh' | 'skip' | 'wait' | null;
}

export interface ExecutionInfo {
  id: string;
  type: 'local' | 'dispatch';
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
  taskId: string | null;
  sessionId: string | null;
  projectId: string | null;
  machine: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  cost: number | null;
}

// Full single-execution detail for the execution detail screen (F3/8b right pane).
// Superset of ExecutionInfo's identifying fields plus nested lifecycle / dispatch /
// metrics / text. `gpu` is the real per-execution GPU captured by the cortex-run watcher
// and delivered via task-callback (DR-0018 §6.3 B2-followup); null when unknown / not captured
// (e.g. `--gpu none`, nvidia-smi unavailable, or a non-task-linked run).
export interface ExecutionDetailInfo {
  id: string;
  type: 'local' | 'dispatch';
  kind: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
  projectId: string | null;
  sessionId: string | null;
  threadId: string | null;
  runtime: { startedAt: string; updatedAt: string; endedAt: string | null };
  dispatch: {
    taskId: string | null;
    machine: string | null;
    pid: string | null;
    tmuxName: string | null;
    sessionName: string | null;
    scheduleTaskId: string | null;
    /** cortex-run `--name`; non-null ⇒ a live `execution.log` stream is subscribable (B2-C 8b). */
    runName: string | null;
  } | null;
  metrics: { costUsd: number | null; numTurns: number | null; durationS: number | null };
  gpu: { indices: number[]; memoryMb: number | null } | null;
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
  /** DR-0012 claude adapter mode. null when the entry does not declare one (resolves to 'print'). */
  claudeBackend: 'print' | 'tui' | null;
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

export interface ConfigThreadTemplates {
  agents: string[];
  templates: string[];
  shells: string[];
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
  /** Registry timeout in SECONDS (template hooks use milliseconds and report null here). */
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
  /** CalVer stamp for managed entries; null for user and template-scoped. */
  version: string | null;
  /** Declaration filename; null for template-scoped hooks, which live in the template file. */
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
  /** True only for user entries — managed gets resynced, template-scoped is owned elsewhere. */
  editable: boolean;
  template: string | null;
  phase: HookPhase | null;
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

export type HooksListParams = Record<string, never>;

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

export interface HooksCreateArgs extends HookDraftInput {
  id: string;
}
export interface HooksCreateReturn {
  id: string;
  fileName: string;
}

export interface HooksUpdateArgs extends HookDraftInput {
  id: string;
}
export interface HooksUpdateReturn {
  changed: boolean;
}

export interface HooksSetEnabledArgs {
  id: string;
  enabled: boolean;
}
export interface HooksSetEnabledReturn {
  changed: boolean;
  /** Non-null when the change is not durable (a managed entry a later sync will restore). */
  warning: string | null;
}

export interface HooksRemoveArgs {
  id: string;
}
export interface HooksRemoveReturn {
  removed: boolean;
}

export interface HooksTestArgs {
  id: string;
  payload: string;
}
export interface HooksTestReturn {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface ConfigSnapshot {
  budget: ConfigBudget | null;
  profiles: ConfigProfiles | null;
  machines: ConfigMachine[];
  mcp: ConfigMcp | null;
  threadTemplates: ConfigThreadTemplates;
  hooks: ConfigHook[];
  env: ConfigEnvEntry[];
  /** Always emitted by current servers; optional while clients and servers roll independently. */
  settings?: ConfigSettingEntry[];
}

// ── machines.list DTO (plan §12 A item 1) ────────────────────────────────────
// Joined view of machines.json (static config) + client-manager (live online state) +
// executionRegistry (running dispatch count). SECURITY: ssh field is a presence flag only —
// the raw user@host string is never returned (same convention as config.get ConfigMachine.ssh).

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
  /** Number of dispatch executions currently running on this machine. */
  liveRuns: number;
}

// ── machines.detail DTO ──────────────────────────────────────────────────────
// Live per-machine probe, fetched lazily when a machine card is expanded. One bash round trip to
// the device (nvidia-smi + nproc/loadavg/free/df/uptime) joined with the running dispatch records.
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
  /** CUDA device ordinal — the same index MachineLiveRun.gpuIndices refers to. */
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

/** A dispatch execution currently running on this machine (from executionRegistry). */
export interface MachineLiveRun {
  executionId: string;
  taskId: string | null;
  runName: string | null;
  project: string | null;
  /** GPU ordinals the run actually acquired (recorded by the client watcher); [] when unknown. */
  gpuIndices: number[];
  startedAt: string | null;
}

export interface MachineDetail {
  name: string;
  online: boolean;
  /** null when the machine is offline or the probe failed. */
  vitals: MachineVitals | null;
  /** Empty when the machine is offline, has no nvidia-smi, or the probe failed. */
  gpus: MachineGpu[];
  liveRuns: MachineLiveRun[];
  /** ISO timestamp of the successful probe; null when no probe ran or it failed. */
  probedAt: string | null;
  /** Human-readable probe failure reason; null when the probe succeeded or was skipped. */
  probeError: string | null;
}

// ── threadTemplates.get DTO (plan §12 A item 3 / 9c) ────────────────────────
// Full body of every thread-template JSON file under
// config/thread-templates/{templates,agents,shells}/*.json.
// `body` is the parsed JSON object (null on parse error). Thread-template files contain
// no secrets (they are orchestration configs); the full body is safe to expose.

export interface ThreadTemplateEntry {
  /** Subdir origin: 'template' (orchestration), 'agent' (execution), 'shell' (shorthand). */
  kind: 'template' | 'agent' | 'shell';
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
  /** Relationship to the shipped defaults. `mergeThreadTemplates` is copy-if-missing and never
   *  overwrites, so editing a `stock` entity forks it from upstream permanently. */
  origin: ThreadTemplateOrigin;
}

/** 'stock' = byte-identical to the shipped default, 'modified' = a shipped name that differs,
 *  'custom' = no shipped default of that name. */
export type ThreadTemplateOrigin = 'stock' | 'modified' | 'custom';

// ── threadTemplates.detail / validate / save / remove ───────────────────────
// The editing surface. `body` is the raw file content (readThreadTemplates reads files directly
// rather than the resolved registry), so `file:` prompt refs survive an edit round-trip.

export interface ThreadTemplateIssue {
  /** Field anchor, e.g. `transitions[2].from`, or `template:<name>` for a knock-on breakage. */
  path: string;
  message: string;
}

export interface ThreadTemplateDetailParams {
  kind: 'template' | 'agent' | 'shell';
  name: string;
}

export interface ThreadTemplateDetail {
  kind: 'template' | 'agent' | 'shell';
  name: string;
  description: string | null;
  body: Record<string, unknown> | null;
  /** Absolute path of the backing file. */
  filePath: string;
  origin: ThreadTemplateOrigin;
  /** Hash of the bytes on disk — pass back as `baseHash` on save to detect a concurrent edit. */
  sha256: string;
  errors: ThreadTemplateIssue[];
  warnings: ThreadTemplateIssue[];
  /** Templates that declare this agent or bind this shell; empty for a template. */
  usedByTemplates: string[];
  /** Non-terminal threads currently running on this template. Transitions are re-read every step,
   *  so editing while these are alive can reroute or stall them. */
  runningThreads: number;
  /** Open TASKS.yaml entries dispatching this template — they break if it is deleted. */
  referencingTasks: number;
  /** For a shell-binding template: the transition graph it expands to. Null otherwise. */
  expanded: Record<string, unknown> | null;
}

export interface ThreadTemplatesValidateArgs {
  kind: 'template' | 'agent' | 'shell';
  name: string;
  body: Record<string, unknown>;
}

export interface ThreadTemplatesValidateReturn {
  ok: boolean;
  errors: ThreadTemplateIssue[];
  warnings: ThreadTemplateIssue[];
}

export interface ThreadTemplatesSaveArgs extends ThreadTemplatesValidateArgs {
  /** Absent creates (the file must not exist); present is the hash the editor loaded, which the
   *  writer compares against disk to reject a save made under a stale editor. */
  baseHash?: string;
}

export interface ThreadTemplatesSaveReturn {
  changed: boolean;
  sha256: string;
  warnings: ThreadTemplateIssue[];
}

export interface ThreadTemplatesRemoveArgs {
  kind: 'template' | 'agent' | 'shell';
  name: string;
}

export interface ThreadTemplatesRemoveReturn {
  removed: boolean;
}

// ── skills.list DTO (plan §12 A item 2 / 8a) ────────────────────────────────
// One group per skill root: null plugin = user-mutable .claude/skills; non-null plugin = a
// plugins/<plugin>/skills directory. Skills within each group are sorted alphabetically.
// Data comes from domain/memory/skill-scanner.ts getDisplaySkillGroups() (60s cache).

export interface SkillGroup {
  /** Plugin name (e.g. 'cortex-common'); null for user-owned skills under DATA_DIR/.claude/skills */
  plugin: string | null;
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

export interface PluginTemplateSlotTarget {
  kind: 'template-slot';
  templateName: string;
  index: number;
  ref: string;
  editable: boolean;
  baseHash: string;
  mode: 'inherit' | 'custom';
  managedPluginIds: string[];
  unmanagedPluginCount: number;
  readOnlyReason?: 'active-agent';
}

export interface PluginTemplateShellBindingTarget {
  kind: 'template-shell';
  templateName: string;
  editable: false;
  baseHash: string;
  readOnlyReason: 'shell-binding';
}

export type PluginAssignmentTarget =
  | PluginAgentTarget
  | PluginTemplateSlotTarget
  | PluginTemplateShellBindingTarget;

export interface PluginsListReturn {
  plugins: UiPluginCatalogEntry[];
  targets: PluginAssignmentTarget[];
}

export interface PluginsAssignAgentTarget {
  kind: 'agent';
  name: string;
  baseHash: string;
}

export interface PluginsAssignTemplateTarget {
  kind: 'template-slot';
  templateName: string;
  index: number;
  ref: string;
  baseHash: string;
  mode: 'inherit' | 'custom';
}

export interface PluginsAssignArgs {
  target: PluginsAssignAgentTarget | PluginsAssignTemplateTarget;
  pluginIds: string[];
  acknowledgeMcp?: boolean;
}

export interface PluginsAssignReturn {
  changed: boolean;
  baseHash: string;
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
  /** Number of `*.md` entry files, excluding the auto-generated `index.md` and `CORTEX.md`. */
  entryCount: number;
  /**
   * The dir's `*.md` entry files (same filter as `entryCount` — excludes `index.md` / `CORTEX.md`),
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

export interface DaemonProcessInfo {
  name: string;
  label: string;
  status: 'running' | 'stopped' | 'unknown';
  pid: number | null;
  uptime: string | null;
  port: number | null;
  extras: Record<string, string | number> | null;
}

export interface SystemDaemonStatus {
  processes: DaemonProcessInfo[];
  lastRestart: { at: string | null; reason: string | null };
}

// ── system.rateLimitStatus DTO ────────────────────────────────────

export interface RateLimitWindowInfo {
  type: string;
  utilization: number | null;
  resetsAt: number;
  activatedAt: number;
}

export interface RateLimitProviderInfo {
  provider: string;
  displayName: string;
  waitingSessions: number;
  waitingThreads: number;
  windows: RateLimitWindowInfo[];
}

export interface SystemRateLimitStatus {
  providers: RateLimitProviderInfo[];
}

// ── system.restart DTO ────────────────────────────────────────────

export interface SystemRestartArgs {
  kind: 'soft' | 'hard' | 'force';
}

export interface SystemRestartReturn {
  ok: boolean;
  message: string;
}

// ── system.clearRateLimit DTO ────────────────────────────────────

export interface SystemClearRateLimitArgs {
  /** Provider key to clear; omit to clear every throttled provider. */
  provider?: string;
}

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

export interface SessionsCreateAndSendReturn {
  /** The id of the newly created session (the client transitions from draft to this session). */
  sessionId: string;
}

export interface ThreadsCancelReturn {
  cancelled: boolean;
}

export interface ExecutionsCancelReturn {
  cancelled: boolean;
}

export interface ConfigSetReturn {
  written: true;
  section: 'budget' | 'profiles' | 'settings';
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

export interface QueryParamMap {
  'projects.list': Record<string, never>;
  'sessions.list': SessionsListParams;
  'sessions.transcript': SessionsTranscriptParams;
  'sessions.pendingInteraction': SessionsPendingInteractionParams;
  'threads.list': ThreadsListParams;
  'threads.get': ThreadsGetParams;
  'tasks.list': TasksListParams;
  'tasks.verification': TaskVerificationParams;
  'schedules.list': SchedulesListParams;
  'executions.list': ExecutionsListParams;
  'executions.get': ExecutionsGetParams;
  'memory.tree': MemoryTreeParams;
  'memory.file': MemoryFileParams;
  'approvals.list': ApprovalsListParams;
  'issues.list': IssuesListParams;
  'notes.list': NotesListParams;
  'cost.summary': CostSummaryParams;
  'config.get': ConfigGetParams;
  'auth.status': AuthStatusParams;
  'auth.flowState': AuthFlowStateParams;
  'auth.customProviders': AuthCustomProvidersParams;
  'hooks.list': HooksListParams;
  'machines.list': MachinesListParams;
  'machines.detail': MachineDetailParams;
  'skills.list': SkillsListParams;
  'plugins.list': PluginsListParams;
  'threadTemplates.get': ThreadTemplatesGetParams;
  'threadTemplates.detail': ThreadTemplateDetailParams;
  'system.daemonStatus': SystemDaemonStatusParams;
  'system.rateLimitStatus': SystemRateLimitStatusParams;
}

export interface QueryReturnMap {
  'projects.list': ProjectConduitInfo[];
  'sessions.list': SessionInfo[];
  'sessions.transcript': SessionTranscript;
  'sessions.pendingInteraction': SessionsPendingInteraction;
  'threads.list': ThreadInfo[];
  'threads.get': ThreadDetail;
  'tasks.list': TaskInfo[];
  'tasks.verification': TaskVerificationInfo;
  'schedules.list': ScheduleInfo[];
  'executions.list': ExecutionInfo[];
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
  'hooks.list': HooksOverview;
  'machines.list': MachineInfo[];
  'machines.detail': MachineDetail;
  'skills.list': SkillGroup[];
  'plugins.list': PluginsListReturn;
  'threadTemplates.get': ThreadTemplateEntry[];
  'threadTemplates.detail': ThreadTemplateDetail;
  'system.daemonStatus': SystemDaemonStatus;
  'system.rateLimitStatus': SystemRateLimitStatus;
}

export interface MutateArgsMap {
  'projects.create': ProjectCreateArgs;
  'sessions.create': SessionsCreateArgs;
  'sessions.send': SessionsSendArgs;
  'sessions.cancel': SessionsCancelArgs;
  'sessions.compact': SessionsCompactArgs;
  'sessions.setProfile': SessionsSetProfileArgs;
  'sessions.createAndSend': SessionsCreateAndSendArgs;
  'sessions.markRead': SessionsMarkReadArgs;
  'sessions.answerQuestion': SessionsAnswerQuestionArgs;
  'sessions.respondPlan': SessionsRespondPlanArgs;
  'sessions.cancelResume': SessionsCancelResumeArgs;
  'sessions.rewind': SessionsRewindArgs;
  'threads.cancel': ThreadsCancelArgs;
  'executions.cancel': ExecutionsCancelArgs;
  'schedules.pause': ScheduleActionArgs;
  'schedules.resume': ScheduleActionArgs;
  'schedules.remove': ScheduleActionArgs;
  'schedules.add': ScheduleAddArgs;
  'schedules.update': ScheduleUpdateArgs;
  'tasks.claim': TaskActionArgs;
  'tasks.unclaim': TaskActionArgs;
  'tasks.complete': TaskCompleteArgs;
  'tasks.block': TaskBlockArgs;
  'tasks.unblock': TaskActionArgs;
  'approvals.approve': ApprovalsApproveArgs;
  'approvals.reject': ApprovalsRejectArgs;
  'approvals.request': ApprovalsRequestArgs;
  'issues.handle': IssueActionArgs;
  'issues.delete': IssueActionArgs;
  'notes.add': NoteAddArgs;
  'notes.update': NoteUpdateArgs;
  'notes.setCompleted': NoteSetCompletedArgs;
  'notes.delete': NoteActionArgs;
  'notes.clearCompleted': NotesClearCompletedArgs;
  'config.set': ConfigSetArgs;
  'auth.startLogin': AuthStartLoginArgs;
  'auth.respondPrompt': AuthRespondPromptArgs;
  'auth.cancelFlow': AuthCancelFlowArgs;
  'auth.logout': AuthLogoutArgs;
  'auth.upsertCustomProvider': AuthUpsertCustomProviderArgs;
  'auth.removeCustomProvider': AuthRemoveCustomProviderArgs;
  'hooks.create': HooksCreateArgs;
  'hooks.update': HooksUpdateArgs;
  'hooks.setEnabled': HooksSetEnabledArgs;
  'hooks.remove': HooksRemoveArgs;
  'hooks.test': HooksTestArgs;
  'profiles.create': ProfilesCreateArgs;
  'profiles.update': ProfilesUpdateArgs;
  'profiles.remove': ProfilesRemoveArgs;
  'plugins.assign': PluginsAssignArgs;
  'threadTemplates.validate': ThreadTemplatesValidateArgs;
  'threadTemplates.save': ThreadTemplatesSaveArgs;
  'threadTemplates.remove': ThreadTemplatesRemoveArgs;
  'system.restart': SystemRestartArgs;
  'system.clearRateLimit': SystemClearRateLimitArgs;
}

export interface MutateReturnMap {
  'projects.create': ProjectCreateReturn;
  'sessions.create': SessionsCreateReturn;
  'sessions.send': SessionsSendReturn;
  'sessions.cancel': SessionsCancelReturn;
  'sessions.compact': SessionsCompactReturn;
  'sessions.setProfile': SessionsSetProfileReturn;
  'sessions.createAndSend': SessionsCreateAndSendReturn;
  'sessions.markRead': void;
  'sessions.answerQuestion': SessionsInteractionMutateReturn;
  'sessions.respondPlan': SessionsInteractionMutateReturn;
  'sessions.cancelResume': SessionsCancelResumeReturn;
  'sessions.rewind': SessionsRewindReturn;
  'threads.cancel': ThreadsCancelReturn;
  'executions.cancel': ExecutionsCancelReturn;
  'schedules.pause': void;
  'schedules.resume': void;
  'schedules.remove': void;
  'schedules.add': ScheduleInfo;
  'schedules.update': ScheduleInfo;
  'tasks.claim': void;
  'tasks.unclaim': void;
  'tasks.complete': void;
  'tasks.block': void;
  'tasks.unblock': void;
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
  'auth.startLogin': LoginFlowState;
  'auth.respondPrompt': LoginFlowState;
  'auth.cancelFlow': LoginFlowState;
  'auth.logout': AuthLogoutReturn;
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
  'threadTemplates.validate': ThreadTemplatesValidateReturn;
  'threadTemplates.save': ThreadTemplatesSaveReturn;
  'threadTemplates.remove': ThreadTemplatesRemoveReturn;
  'system.restart': SystemRestartReturn;
  'system.clearRateLimit': SystemClearRateLimitReturn;
}

export type QueryParams<S extends QueryScope> = S extends keyof QueryParamMap ? QueryParamMap[S] : never;
export type QueryReturn<S extends QueryScope> = S extends keyof QueryReturnMap ? QueryReturnMap[S] : never;
export type MutateArgs<O extends MutateOp> = O extends keyof MutateArgsMap ? MutateArgsMap[O] : never;
export type MutateReturn<O extends MutateOp> = O extends keyof MutateReturnMap ? MutateReturnMap[O] : never;

// ── UiService interface ───────────────────────────────────────────

export interface UiService {
  query<S extends QueryScope>(scope: S, params: QueryParams<S>): Promise<Result<QueryReturn<S>>>;
  mutate<O extends MutateOp>(op: O, args: MutateArgs<O>): Promise<Result<MutateReturn<O>>>;
  subscribe(filter: SubscribeFilter): AsyncIterable<UiEvent> & { close(): void };
  /**
   * Live `execution.log` stream for one running execution (B2-C). Resolves the log location from
   * the executionId, ref-counts the shared tailer (first subscriber starts it, last stops it), and
   * delivers lines over the same bounded queue as `subscribe`. A closed stream when unresolvable.
   */
  subscribeExecutionLog(executionId: string): AsyncIterable<UiEvent> & { close(): void };
}

// ── Deps ──────────────────────────────────────────────────────────

export interface UiServiceDeps {
  /** Optional seams for deterministic authentication dispatch tests. */
  getAuthStatus?: () => Promise<AuthStatusSnapshot>;
  authLogin?: AuthLoginService;
  logoutAccount?: (input: LogoutAccountInput) => Promise<AuthLogoutResult>;
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
    /** Stamp lastReadAt=now (unread tracking; backs `sessions.markRead`). Optional so existing
     *  facade/test fixtures need not provide it (the handler no-ops when absent). */
    markRead?(sessionId: string): Promise<void>;
  };
  /** Capability hint for sessions.list; execution revalidates inside orchestration. */
  supportsSessionCompaction?: (session: Session) => boolean;
  /** Idle-only manual context compaction, injected at the entry layer. */
  compactSession?: (opts: { sessionId: string }) => Promise<
    | { ok: true; status: 'compacted' | 'not-needed'; contextUsage: SessionContextUsage | null }
    | { ok: false; reason: 'not-found' | 'unsupported' | 'running' }
  >;
  /** Backend-independent conversation history — read source for `sessions.transcript` (S4 chat). */
  conversationHistory: {
    getHistory(sessionId: string): Promise<SessionHistory | null>;
    /** First user message text — used to title a label-less session in `sessions.list`. Optional so
     *  facade/test fixtures need not provide it (the handler skips titling when absent). */
    getFirstUserText?(sessionId: string): Promise<string | null>;
  };
  /** Durable active pending-injection snapshot joined into `sessions.transcript`. */
  pendingInjections?: {
    listBySession(sessionId: string): Promise<{
      id: string;
      text: string;
      createdAt: string;
      attachments?: AttachmentMeta[];
    }[]>;
  };
  /**
   * Inject a genuine user turn into a session and route it through the agent (S4 chat send).
   * Fire-and-forget: assistant output returns via the `session.message` stream event, not here.
   * Wired in the entry layer (app.ts) to the orchestration send path — kept as an injected
   * callback so the ui-service domain never imports orchestration (layer safety / depcruise).
   */
  sendSessionMessage: (opts: { sessionId: string; channel: string; text: string; attachments?: AttachmentMeta[] }) => void;
  /**
   * Cancel every live execution running on a session's channel (S4 chat Stop). Wired in the entry
   * layer (app.ts) to the orchestration channel-cancel path (`cancelChannelRuns`), which kills the
   * live agent handle, preserves the session, cancels the thread record, and tears the execution
   * down as `cancelled`. Returns the number cancelled. Kept as an injected callback so the ui-service
   * domain never imports orchestration (layer safety / depcruise).
   */
  cancelSessionRun: (opts: { channel: string }) => Promise<number>;
  /**
   * Message edit + rewind: roll the session back to `turnIndex` and re-send the edited text
   * (orchestration `rewindWebSession` — ledger rollback + backend backup restore + pooled-CLI
   * close + display-history truncate + resend). Wired in the entry layer (app.ts) so the
   * ui-service domain never imports orchestration. Optional so test fixtures need not provide it
   * (the handler returns not-available when absent).
   */
  rewindSession?: (opts: { sessionId: string; channel: string; turnIndex: number; text: string }) => Promise<{ ok: true } | { ok: false; reason: 'running' | 'not-found' }>;
  /**
   * Create a fresh, live user-initiated (origin='direct') session for the workbench and return its
   * id. Injected in the entry layer (app.ts) to the domain `createDirectSession` primitive with the
   * real session/ledger singletons, so the ui-service domain never imports store internals.
   */
  createDirectSession: (opts: { projectId: string; sessionId?: string; profileName?: string | null }) => Promise<{ sessionId: string; sessionName: string; channel: string }>;
  /**
   * Convert a scheduled run's session into a normal direct web session before a reply is sent
   * (design 27b: replying adopts the run — it leaves the schedule grouping and becomes a normal
   * conversation; the next fire starts a fresh session). Injected in the entry layer (app.ts) to
   * the domain `adoptScheduledSession` primitive. Returns the adopted channel, or null when the
   * session is unknown. Optional — the send handler returns not-available when absent.
   */
  adoptScheduledSession?: (opts: { sessionId: string }) => Promise<{ channel: string } | null>;
  /**
   * Move files uploaded under a draft upload id to the real session's attachment directory
   * and return updated AttachmentMeta with corrected paths. No-op when draftUploadId is null.
   * Optional — only needed by sessions.createAndSend; absent in test fixtures.
   */
  moveDraftAttachments?: (opts: { draftUploadId: string | null; sessionId: string; attachments: AttachmentMeta[] }) => Promise<AttachmentMeta[]>;
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
  threadStore: {
    getAll(): any[];
    get(id: string): any | null;
  };
  taskStore: {
    getAll(project?: string): any[];
    getById(taskId: string): any | null;
    load(): void;
    refresh(): void;
  };
  scheduler: {
    list(): Promise<ScheduleTask[]>;
    get(id: string): Promise<ScheduleTask | null>;
    pause(id: string, pausedBy?: 'user' | 'rate-limit'): Promise<ScheduleTask | null>;
    resume(id: string): Promise<ScheduleTask | null>;
    remove(id: string): Promise<boolean>;
    /** Create a schedule (schedules.add). The injected impl (app.ts) composes the real
     *  scheduler.add + schedule-repo backfill of target/fallback, returning the final task. */
    add(
      type: ScheduleTask['type'],
      options: {
        message: string;
        projectId: string;
        profile?: string | null;
        intervalMs?: number;
        time?: string;
        dayOfWeek?: number;
        delay?: number;
        target?: ScheduleTarget;
        fallback?: 'fresh' | 'skip' | 'wait';
      },
    ): Promise<ScheduleTask>;
    /** Patch an existing schedule (schedules.update). Maps to the real scheduler.update
     *  (validateTaskPatch + retiming + reschedule). Returns null when the id is unknown. */
    update(id: string, patch: Record<string, unknown>): Promise<ScheduleTask | null>;
  };
  executionRegistry: {
    getExecution(id: string): any | null;
    getAll(): any[];
    cancelExecution(id: string, metrics?: any): any | null;
  };
  /** Absolute path to PENDING_APPROVALS.md (the approval-center 7a markdown queue). */
  approvalsPath: string;
  /** Ref-counted live log tailer (B2-C). Started/stopped around each execution.log subscription. */
  executionLogTailer: {
    startTail(executionId: string, location: LogLocation): void;
    stopTail(executionId: string): void;
    refCount(executionId: string): number;
  };
  runningExecutions: RunningExecutions;
  costSummary: (projectId?: string | null) => Promise<CostSummary>;
  /**
   * Registry of connected cortex-client devices (from remote/client-manager) plus the
   * static machine config (from tasks/dispatch-utils getMachineRegistry). Injected at the
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
     * Optional so servers/tests without the remote transport degrade to a reported probeError
     * rather than fabricating empty telemetry. The command is built server-side — callers never
     * forward user input into it.
     */
    probeMachine?(device: string, command: string, timeoutMs: number): Promise<string>;
  };
  bus: EventBus;
  adapter: PlatformAdapter;
  /**
   * Return the pending ask-user question group for a channel, if any (web UI pending query).
   * Reads from the in-memory pendingAskUserQuestionGroups Map.
   */
  getPendingAskUser?: (channel: string) => { requestId: string; questions: { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean }[] } | null;
  /**
   * Return the pending plan approval for a channel, if any (web UI pending query).
   * Reads from the in-memory planApprovals Map.
   */
  getPendingPlan?: (channel: string) => { requestId: string; planContent: string; planFilePath: string | null } | null;
  /**
   * Resolve a pending ask-user-question interaction (web UI path). The injected impl (app.ts)
   * looks up the hook group, collects answers, updates the interaction entity, and calls
   * tryResolveHook/resolveHookRequest so the blocked MCP tool receives its response.
   * Three-way outcome: 'resolved' | 'already-resolved' (another client won the race) |
   * 'not-found' (no such interaction).
   */
  answerQuestion?: (requestId: string, answers: Record<string, string>) => 'resolved' | 'already-resolved' | 'not-found';
  /**
   * Resolve a pending plan-approval interaction (web UI path). Same three-way outcome as
   * answerQuestion; the impl calls planApprovals.resolve/reject + entity resolve +
   * resolveHookRequest.
   */
  respondPlan?: (requestId: string, approved: boolean, feedback?: string) => 'resolved' | 'already-resolved' | 'not-found';
  /**
   * Liveness signal for transcript materialization: true only while the interaction is a live,
   * un-expired pending entry in the in-process index. After a restart the index is empty, so
   * still-`pending` persisted rows derive to `expired` at read time.
   */
  isInteractionPending?: (id: string) => boolean;
  /**
   * Web bg-hold snapshot (core/bg-held-sessions, fed from `session.status` events in entry/app.ts):
   * true while the session's foreground turn ended but a background task still holds it. Optional so
   * fixtures / the TUI need not provide it — absent ⇒ no session is held.
   */
  isSessionBgHeld?: (sessionId: string) => boolean;
}
