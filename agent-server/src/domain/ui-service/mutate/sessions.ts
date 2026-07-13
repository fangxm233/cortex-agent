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
  deps.sendSessionMessage({ sessionId: args.sessionId, channel: session.channel, text: args.text });
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
