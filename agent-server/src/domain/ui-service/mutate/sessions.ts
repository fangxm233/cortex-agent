// Injects a genuine user turn into an existing session. Resolves the session's conduit/channel
// (via sessionStore) and hands off to the injected `sendSessionMessage` callback, which is wired
// in the entry layer to the orchestration send path (agentRunner.route). Fire-and-forget: the
// assistant reply returns over the `session.message` stream event, NOT this return.

import type {
  UiServiceDeps,
  Result,
  SessionsCreateReturn,
  SessionsSendReturn,
  SessionsCompactReturn,
  SessionsMarkManyReadReturn,
  SessionsCancelReturn,
  SessionsSetAgentReturn,
  SessionsSetSelectionReturn,
  SessionsCreateAndSendReturn,
  SessionsRespondDecisionReturn,
  SessionsInteractionMutateReturn,
  SessionsRewindReturn,
  SessionsCancelResumeReturn,
  MutateArgs,
} from '../types.js';
import type { AttachmentMeta } from '@core/types/agent-types.js';
import { removeDirectResume } from '@domain/costs/resume-registry.js';
import { projectBoardDecisionAction } from '@domain/boards/decision-projection.js';
import { t } from '@core/i18n.js';

// Create a fresh, live direct session for the workbench "+ New session" control. Resolves the target
// project (falling back to the default project when omitted), delegates the real creation to the
// injected `createDirectSession` dep (domain primitive wired in entry/app.ts), and returns the new
// session's id.
/** The " (expected one of: …)" tail of a refused selection value; empty when the rule gave no list. */
function expectedOneOf(allowed: readonly string[] | undefined): string {
  return allowed ? t('ui.session.expectedOneOf', { values: allowed.join(', ') }) : '';
}

export async function handleCreateSession(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.create'>,
): Promise<Result<SessionsCreateReturn>> {
  const projectId = args.projectId ?? deps.projectStore.getDefault().id;
  const { sessionId } = await deps.createDirectSession({ projectId });
  return { ok: true, data: { sessionId } };
}

export async function handleSendSession(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.send'>,
): Promise<Result<SessionsSendReturn>> {
  if (!args.text.trim() && (!args.attachments || args.attachments.length === 0)) {
    return { ok: false, code: 'invalid-args', message: t('ui.session.textOrAttachments') };
  }
  if (!(await deps.sessionStore.touchSessionUse(args.sessionId))) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  // Scheduled run (design 27b): a reply adopts the run as a normal direct session FIRST — its
  // registry channel is the shared project channel, which a web send must never target.
  let channel = session.channel;
  if (session.kind === 'scheduled') {
    const adopted = await deps.adoptScheduledSession({ sessionId: args.sessionId });
    if (!adopted) {
      return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
    }
    channel = adopted.channel;
  }
  const acceptedAt = new Date().toISOString();
  deps.sendSessionMessage({
    channel,
    text: args.text,
    attachments: args.attachments,
  });
  return { ok: true, data: { accepted: true, acceptedAt } };
}

// S4 chat Stop: cancel the agent(s) currently running for this session. Resolves the session's
// channel and delegates to the injected orchestration channel-cancel path (kills the live handle,
// preserves the session, cancels the thread record, tears the execution down as `cancelled`).
export async function handleCancelSession(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.cancel'>,
): Promise<Result<SessionsCancelReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  const count = await deps.cancelSessionRun({ channel: session.channel });
  return { ok: true, data: { cancelled: count > 0, count } };
}

// Unread tracking: stamp the session's registry lastReadAt=now — the user viewed this session in
// the workbench. `sessions.list` computes `unread = lastUsedAt > lastReadAt` against this stamp.
export async function handleCompactSession(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.compact'>,
): Promise<Result<SessionsCompactReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  const outcome = await deps.compactSession({ sessionId: args.sessionId });
  if (!('reason' in outcome)) {
    return { ok: true, data: { status: outcome.status, contextUsage: outcome.contextUsage } };
  }
  if (outcome.reason === 'running') {
    return {
      ok: false, code: 'session-running',
      message: t('ui.session.runningCompact'),
    };
  }
  if (outcome.reason === 'unsupported') {
    return {
      ok: false, code: 'not-available',
      message: t('ui.session.compactUnsupported'),
    };
  }
  return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
}

export async function handleMarkReadSession(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.markRead'>,
): Promise<Result<void>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  await deps.sessionStore.markRead(args.sessionId);
  return { ok: true, data: undefined };
}

/** Batch mark-read behind the run list's「mark all read」. Deliberately forgiving: a session that
 *  no longer resolves (purged run, stale client list) is skipped instead of failing the batch —
 *  the user asked to clear what they see, and a half-stale list must still clear. */
export async function handleMarkManyReadSessions(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.markManyRead'>,
): Promise<Result<SessionsMarkManyReadReturn>> {
  let marked = 0;
  for (const sessionId of new Set(args.sessionIds)) {
    const session = await deps.sessionStore.getById(sessionId);
    if (!session) continue;
    await deps.sessionStore.markRead(sessionId);
    marked += 1;
  }
  return { ok: true, data: { marked } };
}

// Create a fresh session AND send the first message in one atomic operation. Used by the workbench
// "New Conversation" draft flow (task 15b): the session is created only when the user sends their
// first message, at which point the engine choice is known and the backend is resolved correctly.
// Creates the session via `createDirectSession` with the given selection, then routes the
// message as a fire-and-forget send. Returns the new sessionId so the client can transition from
// draft to a real session.
export async function handleCreateAndSend(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.createAndSend'>,
): Promise<Result<SessionsCreateAndSendReturn>> {
  if (!args.text.trim() && (!args.attachments || args.attachments.length === 0)) {
    return { ok: false, code: 'invalid-args', message: t('ui.session.textOrAttachments') };
  }
  const { sessionId, channel } = await deps.createDirectSession({
    projectId: args.projectId,
    // The draft composer's environment choice, applied at creation for the same reason as the
    // selection below: the agent decides the spawned process's prompt and tool surface, and there
    // is no session to `setAgent` on before the first turn.
    agentName: args.agentName ?? null,
    // Apply the complete engine choice before the first turn.
    selection: args.selection,
  });

  // If the client uploaded files under a draft upload id, move them to the real
  // session's attachment directory and update path references.
  let attachments: AttachmentMeta[] = args.attachments ?? [];
  if (args.draftUploadId && attachments.length > 0) {
    attachments = await deps.moveDraftAttachments({
      draftUploadId: args.draftUploadId,
      sessionId,
      attachments,
    });
  }

  const acceptedAt = new Date().toISOString();
  deps.sendSessionMessage({
    channel,
    text: args.text,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  return { ok: true, data: { sessionId, acceptedAt } };
}

// Switch execution environment independently of the engine. Null follows the default agent.
export async function handleSetAgent(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.setAgent'>,
): Promise<Result<SessionsSetAgentReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  const name = args.agentName ?? null;
  const res = await deps.switchSessionAgent({ channel: session.channel, name });
  if (!res.ok) {
    return { ok: false, code: 'invalid-args', message: t('ui.session.unknownAgent', { name: String(name) }) };
  }
  return { ok: true, data: { agentName: res.agentName } };
}

type SelectionResult = Awaited<ReturnType<UiServiceDeps['applySessionSelection']>>;

function selectionError(result: SelectionResult, args: MutateArgs<'sessions.setSelection'>): Result<never> {
  if (result.reason === 'cross-backend-live-session') {
    return {
      ok: false, code: 'backend-locked',
      message: t('ui.session.backendLocked', { target: result.targetBackend, current: result.currentBackend }),
    };
  }
  const messages: Record<string, () => string> = {
    'invalid-thinking': () => t('ui.session.invalidThinking', {
      level: String(args.selection.thinking), expected: expectedOneOf(result.allowed),
    }),
    'invalid-mode': () => t('ui.session.invalidMode', {
      mode: args.selection.mode, expected: expectedOneOf(result.allowed),
    }),
    'provider-not-supported': () => t('ui.session.noProvider', { provider: String(args.selection.provider) }),
  };
  return { ok: false, code: 'invalid-args', message: messages[result.reason]?.() ?? result.reason ?? 'Invalid selection' };
}

/** Apply the whole engine choice through the shared domain rule, preserving explicit nulls. */
export async function handleSetSelection(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.setSelection'>,
): Promise<Result<SessionsSetSelectionReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  const result = await deps.applySessionSelection({ channel: session.channel, ...args.selection });
  if (!result.ok) return selectionError(result, args);
  const { backend, provider, model, thinking, mode, backendChanged } = result;
  return { ok: true, data: { backend, provider, model, thinking, mode, backendChanged } };
}

// Message edit + rewind (desktop design 23 / mobile 7): resolve session→channel and delegate to
// the injected orchestration rewind path (ledger rollback + backend backup restore + display-history
// truncate + resend). Fire-and-forget like sessions.send — the regenerated reply streams over
// `session.message`. A live run maps to `session-running` (CONFLICT — the UI greys editing out
// while running); an unknown turn maps to not-found.
export async function handleRewindSession(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.rewind'>,
): Promise<Result<SessionsRewindReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  if (!args.text.trim()) {
    return { ok: false, code: 'invalid-args', message: t('ui.session.editEmpty') };
  }
  const res = await deps.rewindSession({
    sessionId: args.sessionId,
    channel: session.channel,
    turnIndex: args.turnIndex,
    text: args.text,
  });
  if (!('reason' in res)) {
    return { ok: true, data: { accepted: true } };
  }
  if (res.reason === 'running') {
    return { ok: false, code: 'session-running', message: t('ui.session.runningEdit') };
  }
  return { ok: false, code: 'not-found', message: t('ui.session.noTurn', { turn: args.turnIndex, id: args.sessionId }) };
}

// Web UI: resolve a pending ask-user-question interaction. The web client renders the question
// card from the transcript's interaction row and submits the answers through this mutation.
// 'already-resolved' (another client / Slack / timeout won the race) is a SUCCESS outcome, not
// an error — the caller refetches the transcript to show the final state.
export async function handleAnswerQuestion(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.answerQuestion'>,
): Promise<Result<SessionsInteractionMutateReturn>> {
  if (!args.requestId) {
    return { ok: false, code: 'invalid-args', message: 'requestId required' };
  }
  const outcome = deps.answerQuestion(args.requestId, args.answers ?? {});
  if (outcome === 'not-found') {
    return { ok: false, code: 'not-found', message: t('ui.session.noPendingQuestion', { id: args.requestId }) };
  }
  return { ok: true, data: { outcome } };
}

// Web UI: decline the auto-resume promised when a rate limit interrupted this session's turn.
// The queue is keyed by conduit, and a web session's conduit is `web:<sessionId>`. Idempotent:
// once the window resets the entry is drained by the dispatcher, so a late click reports
// `cancelled: false` rather than failing.
export async function handleCancelResume(
  args: MutateArgs<'sessions.cancelResume'>,
): Promise<Result<SessionsCancelResumeReturn>> {
  if (!args.sessionId) {
    return { ok: false, code: 'invalid-args', message: 'sessionId required' };
  }
  return { ok: true, data: { cancelled: removeDirectResume(`web:${args.sessionId}`) } };
}

// Web UI: respond to an agent-announced decision card (send_decision). Non-blocking by design —
// there is no pending interaction to resolve. Every response lands as an append-only
// decision-action line on the transcript; `approve` records ONLY (nothing ever reaches the
// agent), while `explain`/`revise` also forward the client-composed message as an ordinary
// user chat message (fire-and-forget, same seam as sessions.send).
export async function handleRespondDecision(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.respondDecision'>,
): Promise<Result<SessionsRespondDecisionReturn>> {
  if (!args.sessionId || !args.decisionId) {
    return { ok: false, code: 'invalid-args', message: 'sessionId and decisionId required' };
  }
  if (args.action !== 'approve' && args.action !== 'explain' && args.action !== 'revise') {
    return { ok: false, code: 'invalid-args', message: `Unknown decision action: ${String(args.action)}` };
  }
  const message = (args.message ?? '').trim();
  if (args.action !== 'approve' && !message) {
    return { ok: false, code: 'invalid-args', message: t('ui.session.decisionMessageRequired', { action: args.action }) };
  }
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: args.sessionId }) };
  }
  const history = await deps.conversationHistory.getHistory(args.sessionId, { includeToolDebug: false });
  const decision = history?.events
    .flatMap(ev => ev.decisions ?? [])
    .find(d => d.id === args.decisionId);
  if (!decision) {
    return { ok: false, code: 'not-found', message: t('ui.session.noDecision', { decision: args.decisionId, id: args.sessionId }) };
  }
  // Idempotent approve: a double-click or a second device is a success, not an error.
  if (args.action === 'approve' && decision.actions.some(a => a.action === 'approve')) {
    return { ok: true, data: { outcome: 'already-approved' } };
  }
  const ts = new Date().toISOString();
  await deps.conversationHistory.appendDecisionAction(args.sessionId, {
    decisionId: args.decisionId,
    action: args.action,
    ...(args.action !== 'approve' ? { message } : {}),
    ts,
  });
  deps.bus.publish({
    type: 'session.decision',
    sessionId: args.sessionId,
    channel: session.channel,
    decisionId: args.decisionId,
    action: args.action,
    ...(args.action !== 'approve' ? { message } : {}),
    ts,
  });
  // Best-effort board projection: never fails the response itself.
  void projectBoardDecisionAction({
    sessionId: args.sessionId, ts, decisionId: args.decisionId, action: args.action,
    ...(args.action !== 'approve' ? { message } : {}),
  }, { bus: deps.bus }).catch(() => {});
  if (args.action !== 'approve') {
    deps.sendSessionMessage({ channel: session.channel, text: message });
  }
  return { ok: true, data: { outcome: 'recorded' } };
}

// Web UI: resolve a pending plan-approval interaction. Same three-way outcome as
// handleAnswerQuestion.
export async function handleRespondPlan(
  deps: UiServiceDeps,
  args: MutateArgs<'sessions.respondPlan'>,
): Promise<Result<SessionsInteractionMutateReturn>> {
  if (!args.requestId) {
    return { ok: false, code: 'invalid-args', message: 'requestId required' };
  }
  const outcome = deps.respondPlan(args.requestId, args.approved, args.feedback);
  if (outcome === 'not-found') {
    return { ok: false, code: 'not-found', message: t('ui.session.noPendingPlan', { id: args.requestId }) };
  }
  return { ok: true, data: { outcome } };
}
