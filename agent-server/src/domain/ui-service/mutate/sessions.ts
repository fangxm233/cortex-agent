// Injects a genuine user turn into an existing session. Resolves the session's conduit/channel
// (via sessionStore) and hands off to the injected `sendSessionMessage` callback, which is wired
// in the entry layer to the orchestration send path (agentRunner.route). Fire-and-forget: the
// assistant reply returns over the `session.message` stream event, NOT this return.

import type {
  UiServiceDeps,
  Result,
  SessionsCreateArgs,
  SessionsCreateReturn,
  SessionsSendArgs,
  SessionsSendReturn,
  SessionsCancelArgs,
  SessionsCompactArgs,
  SessionsCompactReturn,
  SessionsMarkReadArgs,
  SessionsMarkManyReadArgs,
  SessionsMarkManyReadReturn,
  SessionsCancelReturn,
  SessionsSetProfileArgs,
  SessionsSetProfileReturn,
  SessionsSetAgentArgs,
  SessionsSetAgentReturn,
  SessionsSetSelectionArgs,
  SessionsSetSelectionReturn,
  SessionsSetCommissionArgs,
  SessionsSetCommissionReturn,
  SessionsCreateAndSendArgs,
  SessionsCreateAndSendReturn,
  SessionsAnswerQuestionArgs,
  SessionsRespondPlanArgs,
  SessionsRespondDecisionArgs,
  SessionsRespondDecisionReturn,
  SessionsInteractionMutateReturn,
  SessionsRewindArgs,
  SessionsRewindReturn,
  SessionsCancelResumeArgs,
  SessionsCancelResumeReturn,
} from '../types.js';
import { removeDirectResume } from '@domain/costs/resume-registry.js';
import { projectCommissionDecisionAction } from '@domain/commissions/decision-projection.js';
import { enterCommissionDraft, leaveCommissionDraft } from '@domain/commissions/commission-draft.js';
import { commissionRepo } from '@store/commission-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getSettings } from '@core/settings.js';

// Create a fresh, live direct session for the workbench "+ New session" control. Resolves the target
// project (falling back to the default project when omitted), delegates the real creation to the
// injected `createDirectSession` dep (domain primitive wired in entry/app.ts), and returns the new
// session's id.
/** Commission mode ships behind `settings.commissionEnabled`, its kill switch (on by default since
 *  DR-0037 v4). The composer hides the opt-in when it is off, so reaching this is either a stale
 *  client or a direct API call; answer with a 400 rather than letting createDirectSession throw. */
function commissionDisabled(commission: unknown): Result<never> | null {
  if (!commission || getSettings().commissionEnabled) return null;
  return {
    ok: false,
    code: 'invalid-args',
    message: 'Commission mode is disabled; enable settings.commissionEnabled to use it',
  };
}

export async function handleCreateSession(
  deps: UiServiceDeps,
  args: SessionsCreateArgs,
): Promise<Result<SessionsCreateReturn>> {
  const disabled = commissionDisabled(args.commission);
  if (disabled) return disabled;
  const projectId = args.projectId ?? deps.projectStore.getDefault().id;
  const { sessionId } = await deps.createDirectSession({
    projectId, browser: args.browser ?? null, commission: args.commission ?? null,
  });
  return { ok: true, data: { sessionId } };
}

/**
 * Switch a LIVE session in or out of commission mode (DR-0037 v4).
 *
 * The user's half of "either side may start a commission": the agent calls
 * `cortex_commission_start`, the user flips the composer's capsule, and both land in the same
 * `enterCommissionDraft`. It exists for a session already in flight — creation could only ever say
 * yes at birth, which meant a conversation that turned into a long task had no way in.
 *
 * `bound` is terminal: a second contract would orphan the first, so a bound session refuses every
 * transition (open a new session and join instead).
 */
export async function handleSetCommission(
  deps: UiServiceDeps,
  args: SessionsSetCommissionArgs,
): Promise<Result<SessionsSetCommissionReturn>> {
  // `off` stays allowed with the feature switched off: a session left drafting when the switch
  // flipped must still be able to get out.
  const disabled = commissionDisabled(args.commission.mode === 'off' ? null : args.commission);
  if (disabled) return disabled;
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  if (session.commissionId) {
    return {
      ok: false,
      code: 'invalid-args',
      message: 'This session is already bound to a commission — open a new session to work on another one',
    };
  }

  const settled = (removedDraftDir?: boolean): Result<SessionsSetCommissionReturn> => ({
    ok: true,
    data: {
      phase: 'none', commissionId: null, commissionDraft: null,
      ...(removedDraftDir === undefined ? {} : { removedDraftDir }),
    },
  });

  if (args.commission.mode === 'off') {
    const left = await leaveCommissionDraft(args.sessionId);
    if (left.ok === false) return { ok: false, code: 'invalid-args', message: left.error };
    deps.bus.publish({ type: 'session.commission', sessionId: args.sessionId, channel: session.channel });
    return settled(left.removed);
  }

  if (args.commission.mode === 'join') {
    const commission = await (deps.commissionStore ?? commissionRepo).find(args.commission.commissionId);
    if (!commission) {
      return { ok: false, code: 'not-found', message: `Commission not found: ${args.commission.commissionId}` };
    }
    if (commission.status !== 'active') {
      return { ok: false, code: 'invalid-args', message: `Commission is ${commission.status}; only an active one accepts new sessions` };
    }
    // Joining mid-conversation is safe because the [Commission] block follows the binding rather
    // than the session's first turn: the next turn carries the contract index (DR-0037 v4).
    await sessionStore.bindCommission(args.sessionId, commission.id);
    deps.bus.publish({ type: 'commission.updated', commissionId: commission.id, projectId: commission.projectId });
    return { ok: true, data: { phase: 'active', commissionId: commission.id, commissionDraft: null } };
  }

  const entered = await enterCommissionDraft(args.sessionId);
  if (entered.ok === false) return { ok: false, code: 'invalid-args', message: entered.error };
  if (!entered.alreadyDrafting) {
    deps.bus.publish({ type: 'session.commission', sessionId: args.sessionId, channel: session.channel });
  }
  return { ok: true, data: { phase: 'draft', commissionId: null, commissionDraft: entered.draftDir } };
}

export async function handleSendSession(
  deps: UiServiceDeps,
  args: SessionsSendArgs,
): Promise<Result<SessionsSendReturn>> {
  if (!args.text.trim() && (!args.attachments || args.attachments.length === 0)) {
    return { ok: false, code: 'invalid-args', message: 'Either text or attachments required' };
  }
  if (deps.sessionStore.touchSessionUse && !(await deps.sessionStore.touchSessionUse(args.sessionId))) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  // Scheduled run (design 27b): a reply adopts the run as a normal direct session FIRST — its
  // registry channel is the shared project channel, which a web send must never target.
  let channel = session.channel;
  if (session.kind === 'scheduled') {
    if (!deps.adoptScheduledSession) {
      return { ok: false, code: 'not-available', message: 'Replying to scheduled runs is not available' };
    }
    const adopted = await deps.adoptScheduledSession({ sessionId: args.sessionId });
    if (!adopted) {
      return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
    }
    channel = adopted.channel;
  }
  const acceptedAt = new Date().toISOString();
  deps.sendSessionMessage({
    sessionId: args.sessionId,
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
  args: SessionsCancelArgs,
): Promise<Result<SessionsCancelReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  const count = await deps.cancelSessionRun({ channel: session.channel });
  return { ok: true, data: { cancelled: count > 0, count } };
}

// Unread tracking: stamp the session's registry lastReadAt=now — the user viewed this session in
// the workbench. `sessions.list` computes `unread = lastUsedAt > lastReadAt` against this stamp.
export async function handleCompactSession(
  deps: UiServiceDeps,
  args: SessionsCompactArgs,
): Promise<Result<SessionsCompactReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  if (!deps.compactSession) {
    return { ok: false, code: 'not-available', message: 'Session compaction is not available' };
  }
  const outcome = await deps.compactSession({ sessionId: args.sessionId });
  if (!('reason' in outcome)) {
    return { ok: true, data: { status: outcome.status, contextUsage: outcome.contextUsage } };
  }
  if (outcome.reason === 'running') {
    return {
      ok: false, code: 'session-running',
      message: 'Session is running — stop it before compacting context',
    };
  }
  if (outcome.reason === 'unsupported') {
    return {
      ok: false, code: 'not-available',
      message: 'This session backend does not support manual context compaction',
    };
  }
  return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
}

export async function handleMarkReadSession(
  deps: UiServiceDeps,
  args: SessionsMarkReadArgs,
): Promise<Result<void>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  await deps.sessionStore.markRead?.(args.sessionId);
  return { ok: true, data: undefined };
}

/** Batch mark-read behind the run list's「mark all read」. Deliberately forgiving: a session that
 *  no longer resolves (purged run, stale client list) is skipped instead of failing the batch —
 *  the user asked to clear what they see, and a half-stale list must still clear. */
export async function handleMarkManyReadSessions(
  deps: UiServiceDeps,
  args: SessionsMarkManyReadArgs,
): Promise<Result<SessionsMarkManyReadReturn>> {
  let marked = 0;
  for (const sessionId of new Set(args.sessionIds)) {
    const session = await deps.sessionStore.getById(sessionId);
    if (!session) continue;
    await deps.sessionStore.markRead?.(sessionId);
    marked += 1;
  }
  return { ok: true, data: { marked } };
}

// Create a fresh session AND send the first message in one atomic operation. Used by the workbench
// "New Conversation" draft flow (task 15b): the session is created only when the user sends their
// first message, at which point the profile is already known and the backend is resolved correctly.
// Creates the session via `createDirectSession` with the given profileName, then routes the
// message as a fire-and-forget send. Returns the new sessionId so the client can transition from
// draft to a real session.
export async function handleCreateAndSend(
  deps: UiServiceDeps,
  args: SessionsCreateAndSendArgs,
): Promise<Result<SessionsCreateAndSendReturn>> {
  if (!args.text.trim() && (!args.attachments || args.attachments.length === 0)) {
    return { ok: false, code: 'invalid-args', message: 'Either text or attachments required' };
  }
  const disabled = commissionDisabled(args.commission);
  if (disabled) return disabled;

  const { sessionId, channel } = await deps.createDirectSession({
    projectId: args.projectId,
    profileName: args.profileName ?? null,
    // The draft composer's environment choice, applied at creation for the same reason as the
    // selection below: the agent decides the spawned process's prompt and tool surface, and there
    // is no session to `setAgent` on before the first turn.
    agentName: args.agentName ?? null,
    // The draft composer's model/thinking choice, applied at creation so the FIRST turn already
    // runs it — there is no session to `setSelection` on before this call. A composer that sends
    // none is stating the empty selection ("follow the profile"), not staying silent: this is the
    // one create path that always has a composer behind it, and the empty case is exactly the one
    // that has to re-seed what the NEXT new conversation opens on.
    selection: args.selection ?? {},
    browser: args.browser ?? null,
    commission: args.commission ?? null,
  });

  // If the client uploaded files under a draft upload id, move them to the real
  // session's attachment directory and update path references.
  let attachments = args.attachments ?? [];
  if (args.draftUploadId && attachments.length > 0 && deps.moveDraftAttachments) {
    attachments = await deps.moveDraftAttachments({
      draftUploadId: args.draftUploadId,
      sessionId,
      attachments,
    });
  }

  const acceptedAt = new Date().toISOString();
  deps.sendSessionMessage({
    sessionId,
    channel,
    text: args.text,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  return { ok: true, data: { sessionId, acceptedAt } };
}

// Switch the session's active profile under the shared profile-switch rule (the same
// `switchChannelProfile` the Slack/Feishu `!profile` command uses, injected as `switchSessionProfile`).
// Resolves the session→channel, delegates to the rule, and maps its structured outcome to a Result:
//   • unknown-profile            → invalid-args
//   • cross-backend-live-session → conflict (the conversation can't swap backends; start a new session)
// A same-backend switch keeps the conversation (no reset) — only the model changes on the next turn.
export async function handleSetProfile(
  deps: UiServiceDeps,
  args: SessionsSetProfileArgs,
): Promise<Result<SessionsSetProfileReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  const res = await deps.switchSessionProfile({ channel: session.channel, name: args.profileName });
  if (!res.ok) {
    if (res.reason === 'unknown-profile') {
      return { ok: false, code: 'invalid-args', message: `Unknown profile: ${args.profileName}` };
    }
    return {
      ok: false,
      code: 'backend-locked', // maps to CONFLICT in the tRPC layer
      message: `Can't switch to "${res.name}" (${res.targetBackend}) — this conversation runs on ${res.currentBackend}. Start a new session to change backend.`,
    };
  }
  return { ok: true, data: { profileName: res.name, backendChanged: res.backendChanged } };
}

// Switch the session's agent — its execution environment — under the shared agent-switch rule (the
// same `switchChannelAgent` the Slack/Feishu `!agent` command uses, injected as `switchSessionAgent`).
// The error mapping is `handleSetProfile`'s, for the same reasons:
//   • unknown-agent              → invalid-args
//   • cross-backend-live-session → conflict (an agent pinning a profile on the other backend is a
//                                  backend move; a live conversation can't be resumed there)
// A null `agentName` clears the selection: the session follows the global default again.
export async function handleSetAgent(
  deps: UiServiceDeps,
  args: SessionsSetAgentArgs,
): Promise<Result<SessionsSetAgentReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  if (!deps.switchSessionAgent) {
    return { ok: false, code: 'not-available', message: 'Agent selection is not available' };
  }
  const name = args.agentName ?? null;
  const res = await deps.switchSessionAgent({ channel: session.channel, name });
  if (!res.ok) {
    if (res.reason === 'unknown-agent') {
      return { ok: false, code: 'invalid-args', message: `Unknown agent: ${String(name)}` };
    }
    return {
      ok: false,
      code: 'backend-locked', // maps to CONFLICT in the tRPC layer
      message: `Can't switch to "${String(name)}" (${res.targetBackend}) — this conversation runs on ${res.currentBackend}. Start a new session to change backend.`,
    };
  }
  return {
    ok: true,
    data: {
      agentName: res.agentName,
      profileName: res.effectiveProfile,
      backendChanged: res.backendChanged,
    },
  };
}

// Change what the session's next turn runs — its profile, its model, its PI provider, its thinking
// level, or any combination — through the ONE domain rule (`applyChannelSelection`, injected as
// `applySessionSelection`). The composer's greying-out is a preview of that rule; this is where it
// is enforced. Refusals map to:
//   • unknown-profile / provider-not-supported / invalid-thinking → invalid-args
//   • cross-backend-live-session                                  → conflict (start a new session)
// A same-backend change keeps the conversation — only the next turn differs.
export async function handleSetSelection(
  deps: UiServiceDeps,
  args: SessionsSetSelectionArgs,
): Promise<Result<SessionsSetSelectionReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  if (!deps.applySessionSelection) {
    return { ok: false, code: 'not-available', message: 'Model selection is not available' };
  }
  // Wire shape → domain shape: the client states the whole selection, the domain takes a patch, so
  // a field the client left out is an explicit "back to the profile's value".
  const stated = args.selection;
  const result = await deps.applySessionSelection({
    channel: session.channel,
    profileName: args.profileName,
    ...(stated
      ? {
        model: stated.model ?? null, provider: stated.provider ?? null,
        thinking: stated.thinking ?? null, mode: stated.mode ?? null,
      }
      : {}),
  });
  if (!result.ok) {
    if (result.reason === 'cross-backend-live-session') {
      return {
        ok: false,
        code: 'backend-locked', // maps to CONFLICT in the tRPC layer
        message: `Can't switch to ${result.targetBackend} — this conversation runs on ${result.currentBackend}. Start a new session to change backend.`,
      };
    }
    if (result.reason === 'invalid-thinking') {
      return {
        ok: false, code: 'invalid-args',
        message: `Unsupported thinking level: ${String(args.selection?.thinking)}${result.allowed ? ` (expected one of: ${result.allowed.join(', ')})` : ''}`,
      };
    }
    if (result.reason === 'invalid-mode') {
      return {
        ok: false, code: 'invalid-args',
        message: `This session's gateway has no route "${String(args.selection?.mode)}"`
          + `${result.allowed ? ` (expected one of: ${result.allowed.join(', ')})` : ''}`,
      };
    }
    if (result.reason === 'provider-not-supported') {
      return {
        ok: false, code: 'invalid-args',
        message: `This session's backend has no provider to select (requested: ${String(args.selection?.provider)})`,
      };
    }
    return { ok: false, code: 'invalid-args', message: `Unknown profile: ${String(args.profileName)}` };
  }
  return {
    ok: true,
    data: {
      profileName: result.profileName,
      backend: result.backend,
      model: result.model,
      provider: result.provider,
      thinking: result.thinking,
      mode: result.mode,
      override: result.override,
      backendChanged: result.backendChanged,
    },
  };
}

// Message edit + rewind (desktop design 23 / mobile 7): resolve session→channel and delegate to
// the injected orchestration rewind path (ledger rollback + backend backup restore + display-history
// truncate + resend). Fire-and-forget like sessions.send — the regenerated reply streams over
// `session.message`. A live run maps to `session-running` (CONFLICT — the UI greys editing out
// while running); an unknown turn maps to not-found.
export async function handleRewindSession(
  deps: UiServiceDeps,
  args: SessionsRewindArgs,
): Promise<Result<SessionsRewindReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  if (!args.text.trim()) {
    return { ok: false, code: 'invalid-args', message: 'Edited text must not be empty' };
  }
  if (!deps.rewindSession) {
    return { ok: false, code: 'not-available', message: 'rewindSession not wired' };
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
    return { ok: false, code: 'session-running', message: 'Session is running — stop it before editing' };
  }
  return { ok: false, code: 'not-found', message: `No turn ${args.turnIndex} to rewind in session ${args.sessionId}` };
}

// Web UI: resolve a pending ask-user-question interaction. The web client renders the question
// card from the transcript's interaction row and submits the answers through this mutation.
// 'already-resolved' (another client / Slack / timeout won the race) is a SUCCESS outcome, not
// an error — the caller refetches the transcript to show the final state.
export async function handleAnswerQuestion(
  deps: UiServiceDeps,
  args: SessionsAnswerQuestionArgs,
): Promise<Result<SessionsInteractionMutateReturn>> {
  if (!deps.answerQuestion) {
    return { ok: false, code: 'not-available', message: 'answerQuestion not wired' };
  }
  if (!args.requestId) {
    return { ok: false, code: 'invalid-args', message: 'requestId required' };
  }
  const outcome = deps.answerQuestion(args.requestId, args.answers ?? {});
  if (outcome === 'not-found') {
    return { ok: false, code: 'not-found', message: `No pending question for requestId: ${args.requestId}` };
  }
  return { ok: true, data: { outcome } };
}

// Web UI: decline the auto-resume promised when a rate limit interrupted this session's turn.
// The queue is keyed by conduit, and a web session's conduit is `web:<sessionId>`. Idempotent:
// once the window resets the entry is drained by the dispatcher, so a late click reports
// `cancelled: false` rather than failing.
export async function handleCancelResume(
  args: SessionsCancelResumeArgs,
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
  args: SessionsRespondDecisionArgs,
): Promise<Result<SessionsRespondDecisionReturn>> {
  if (!args.sessionId || !args.decisionId) {
    return { ok: false, code: 'invalid-args', message: 'sessionId and decisionId required' };
  }
  if (args.action !== 'approve' && args.action !== 'explain' && args.action !== 'revise') {
    return { ok: false, code: 'invalid-args', message: `Unknown decision action: ${String(args.action)}` };
  }
  const message = (args.message ?? '').trim();
  if (args.action !== 'approve' && !message) {
    return { ok: false, code: 'invalid-args', message: `message required for action "${args.action}"` };
  }
  if (!deps.conversationHistory.appendDecisionAction) {
    return { ok: false, code: 'not-available', message: 'appendDecisionAction not wired' };
  }
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  const history = await deps.conversationHistory.getHistory(args.sessionId, { includeToolDebug: false });
  const decision = history?.events
    .flatMap(ev => ev.decisions ?? [])
    .find(d => d.id === args.decisionId);
  if (!decision) {
    return { ok: false, code: 'not-found', message: `No decision ${args.decisionId} in session ${args.sessionId}` };
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
  // Best-effort commission projection (DR-0037): never fails the response itself.
  void projectCommissionDecisionAction({
    sessionId: args.sessionId, ts, decisionId: args.decisionId, action: args.action,
    ...(args.action !== 'approve' ? { message } : {}),
  }).catch(() => {});
  if (args.action !== 'approve') {
    deps.sendSessionMessage({ sessionId: args.sessionId, channel: session.channel, text: message });
  }
  return { ok: true, data: { outcome: 'recorded' } };
}

// Web UI: resolve a pending plan-approval interaction. Same three-way outcome as
// handleAnswerQuestion.
export async function handleRespondPlan(
  deps: UiServiceDeps,
  args: SessionsRespondPlanArgs,
): Promise<Result<SessionsInteractionMutateReturn>> {
  if (!deps.respondPlan) {
    return { ok: false, code: 'not-available', message: 'respondPlan not wired' };
  }
  if (!args.requestId) {
    return { ok: false, code: 'invalid-args', message: 'requestId required' };
  }
  const outcome = deps.respondPlan(args.requestId, args.approved, args.feedback);
  if (outcome === 'not-found') {
    return { ok: false, code: 'not-found', message: `No pending plan for requestId: ${args.requestId}` };
  }
  return { ok: true, data: { outcome } };
}
