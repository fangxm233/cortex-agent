// input:  UiServiceDeps and session mutation arguments
// output: create/send/cancel/compact/profile/rewind handlers
// pos:    UI-service session mutation handlers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
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
  SessionsCancelReturn,
  SessionsSetProfileArgs,
  SessionsSetProfileReturn,
  SessionsCreateAndSendArgs,
  SessionsCreateAndSendReturn,
  SessionsAnswerQuestionArgs,
  SessionsRespondPlanArgs,
  SessionsInteractionMutateReturn,
  SessionsRewindArgs,
  SessionsRewindReturn,
} from '../types.js';

// Create a fresh, live direct session for the workbench "+ New session" control. Resolves the target
// project (falling back to the default project when omitted), delegates the real creation to the
// injected `createDirectSession` dep (domain primitive wired in entry/app.ts), and returns the new
// session's id.
export async function handleCreateSession(
  deps: UiServiceDeps,
  args: SessionsCreateArgs,
): Promise<Result<SessionsCreateReturn>> {
  const projectId = args.projectId ?? deps.projectStore.getDefault().id;
  const { sessionId } = await deps.createDirectSession({ projectId });
  return { ok: true, data: { sessionId } };
}

export async function handleSendSession(
  deps: UiServiceDeps,
  args: SessionsSendArgs,
): Promise<Result<SessionsSendReturn>> {
  const session = await deps.sessionStore.getById(args.sessionId);
  if (!session) {
    return { ok: false, code: 'not-found', message: `Session not found: ${args.sessionId}` };
  }
  if (!args.text.trim() && (!args.attachments || args.attachments.length === 0)) {
    return { ok: false, code: 'invalid-args', message: 'Either text or attachments required' };
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
  deps.sendSessionMessage({
    sessionId: args.sessionId,
    channel,
    text: args.text,
    attachments: args.attachments,
  });
  return { ok: true, data: { accepted: true } };
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

  const { sessionId, channel } = await deps.createDirectSession({
    projectId: args.projectId,
    profileName: args.profileName ?? null,
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

  deps.sendSessionMessage({
    sessionId,
    channel,
    text: args.text,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  return { ok: true, data: { sessionId } };
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
