// input:  session-registry-repo (sessionStore), session-repo (sessions.json), conversation-ledger-repo, session-backup, setActiveProfile
// output: registerNamedSession / attachExistingSession / resetChannelSession — shared session lifecycle primitives
// pos:    domain/sessions — centralized session lifecycle for agent-runner, tui-session-service, and commands/session

import * as crypto from 'node:crypto';
import { setSessionAsync, deleteSessionAsync } from './session.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { setActiveProfile } from '@domain/agents/index.js';
import { resolveProfileConfig } from '@domain/agents/profile-manager.js';
import * as sessionBackup from './session-backup.js';
import type { SessionOrigin } from '@store/session-registry-repo.js';

export const SESSION_BACKENDS = ['claude', 'pi', 'codex'] as const;

export interface SessionRegistryWriter {
  generateSessionName(): Promise<string>;
  registerSession(name: string, opts: {
    sessionId: string; channel: string; backend: string;
    kind: 'local' | 'scheduled'; origin?: SessionOrigin; projectId: string;
    label?: string | null; profileName?: string | null;
  }): Promise<void>;
}

export interface RegisterNamedSessionOpts {
  sessionId: string;
  channel: string;
  backend: string;
  projectId: string;
  kind?: 'local' | 'scheduled';
  /** How the session was initiated. Defaults to 'direct' — the only caller path here
   *  (inbound direct message + TUI fresh session) is user-initiated. */
  origin?: SessionOrigin;
  label?: string | null;
  profileName?: string | null;
}

/** Generate a fresh session name and register a registry record for sessionId. Returns the name.
 *  Centralizes the generateSessionName + registerSession pairing used by inbound-message session
 *  creation (agent-runner) and TUI fresh-session creation. */
export async function registerNamedSession(store: SessionRegistryWriter, opts: RegisterNamedSessionOpts): Promise<string> {
  const name = await store.generateSessionName();
  await store.registerSession(name, {
    sessionId: opts.sessionId,
    channel: opts.channel,
    backend: opts.backend,
    kind: opts.kind ?? 'local',
    origin: opts.origin ?? 'direct',
    projectId: opts.projectId,
    label: opts.label ?? null,
    profileName: opts.profileName ?? null,
  });
  return name;
}

export interface CreateDirectSessionDeps {
  sessionStore: SessionRegistryWriter;
  /** Point the channel's sessions.json entry at the new session (so a later send resumes it). */
  setChannelSession(channel: string, sessionId: string, backend: string): Promise<void>;
  /** Initialize the conversation ledger for the new channel/session. */
  initConversation(channel: string, opts: { sessionId: string; sessionName: string; backend: string }): Promise<void>;
  /** Resolve the backend the send path will use for the channel (agent-runner reads the same). */
  resolveBackend(channel: string): string;
}

/** Create a fresh, live user-initiated (origin='direct') session for a web/UI conversation: mint a
 *  sessionId, derive its own `web:<sessionId>` conduit channel, register the named session, bind the
 *  channel→session mapping and conversation ledger. Returns the sessionId + generated name + channel.
 *
 *  When `profileName` is provided, the backend is resolved directly from the profile config (not
 *  from the channel's profile state) so the session is bound to the correct backend even before any
 *  channel profile is set. The channel profile is then set so subsequent sends resolve correctly.
 *
 *  Because the channel is bound with the same backend the send path resolves, a subsequent send
 *  resumes THIS session rather than spawning a new one. */
export async function createDirectSession(
  deps: CreateDirectSessionDeps,
  opts: { projectId: string; sessionId?: string; profileName?: string | null },
): Promise<{ sessionId: string; sessionName: string; channel: string }> {
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const channel = `web:${sessionId}`;

  let backend: string;
  if (opts.profileName) {
    backend = resolveProfileConfig(opts.profileName).backend;
    setActiveProfile(opts.profileName, channel);
  } else {
    backend = deps.resolveBackend(channel);
  }

  const sessionName = await registerNamedSession(deps.sessionStore, {
    sessionId,
    channel,
    backend,
    projectId: opts.projectId,
    origin: 'direct',
    profileName: opts.profileName ?? null,
  });
  await deps.setChannelSession(channel, sessionId, backend);
  await deps.initConversation(channel, { sessionId, sessionName, backend });
  return { sessionId, sessionName, channel };
}

export interface AttachExistingSessionOpts {
  sessionId: string;
  sessionName: string;
  backend: string;
  profileName?: string | null;
}

/** Attach a channel to an existing session: restore its profile (if any), point sessions.json at it,
 *  and switch the conversation ledger. Mirrors the !resume switch sequence. */
export async function attachExistingSession(channel: string, opts: AttachExistingSessionOpts): Promise<void> {
  if (opts.profileName) setActiveProfile(opts.profileName, channel);
  await setSessionAsync(channel, opts.sessionId, opts.backend);
  await conversationLedger.switchSession(channel, {
    sessionId: opts.sessionId, sessionName: opts.sessionName, backend: opts.backend, profileName: opts.profileName,
  });
}

/** Clear a channel's session state: drop sessions.json keys for every backend, clean session
 *  backups, and clear the conversation ledger. Mirrors the store-level half of !new. */
export async function resetChannelSession(channel: string): Promise<void> {
  const conv = await conversationLedger.getConversation(channel);
  if (conv) {
    sessionBackup.cleanupAllBackups(conv.sessionId);
    await conversationLedger.clearConversation(channel);
  }
  await Promise.all(SESSION_BACKENDS.map(b => deleteSessionAsync(channel, b).catch(() => {})));
}
