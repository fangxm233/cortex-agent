// input:  UiServiceDeps + { sessionId, text }
// output: handleSendSession → Ok<{accepted:true}> | Err
// pos:    mutate handler for 'sessions.send' (S4 chat)
//
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
  SessionsCancelReturn,
  SessionsSetProfileArgs,
  SessionsSetProfileReturn,
  SessionsCreateAndSendArgs,
  SessionsCreateAndSendReturn,
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
  deps.sendSessionMessage({
    sessionId: args.sessionId,
    channel: session.channel,
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
