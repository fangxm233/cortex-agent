import * as crypto from 'node:crypto';
import { setSessionAsync, deleteSessionAsync } from './session.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import {
  applyChannelSelection, setActiveProfile, setDefaultAgent, setSelectionDefaultAgent,
} from '@domain/agents/index.js';
import { resolveProfileConfig } from '@domain/agents/profile-manager.js';
import * as sessionBackup from './session-backup.js';
import type { SessionOrigin } from '@store/session-registry-repo.js';
import type { SessionBrowserOption } from '@store/session-registry-journal.js';
import { resolveCommissionCreate, type CommissionCreateRequest } from '@domain/commissions/commission-draft.js';
import { getSettings } from '@core/settings.js';

export interface SessionRegistryWriter {
  registerSession(opts: {
    sessionId: string; channel: string; backend: string;
    kind: 'local' | 'scheduled'; origin?: SessionOrigin; projectId: string;
    label?: string | null; profileName?: string | null; agentName?: string | null;
    browser?: SessionBrowserOption | null;
    commissionId?: string | null; commissionDraft?: string | null;
    teamLeadId?: string | null; workerName?: string | null; workerBrief?: string | null;
    scheduleId?: string | null;
  }): Promise<void>;
}

export interface RegisterSessionRecordOpts {
  sessionId: string;
  channel: string;
  backend: string;
  projectId: string;
  label?: string | null;
  profileName?: string | null;
  /** The agent template the session runs as; null/absent means it follows the channel's selection
   *  and, beneath that, the global default. */
  agentName?: string | null;
  /** Opt-in browser access for this session; null/absent means no browser tools at all. */
  browser?: SessionBrowserOption | null;
  /** Resolve commission fields using the new session ID. */
  commissionFor?: (sessionId: string) => Promise<{ commissionId?: string | null; commissionDraft?: string | null }>;
  /** Team mode: the owning lead's sessionId, this worker's name and its brief. Absent for ordinary
   *  sessions. */
  teamLeadId?: string | null;
  workerName?: string | null;
  workerBrief?: string | null;
  /** The schedule whose fire opened this session. Present, the session is that schedule's run
   *  (kind and origin 'scheduled') until a reply adopts it as an ordinary direct session. */
  scheduleId?: string | null;
}

/** Register a session by its stable ID; resolve commission fields before persisting. */
export async function registerSessionRecord(store: SessionRegistryWriter, opts: RegisterSessionRecordOpts): Promise<void> {
  const commission = opts.commissionFor ? await opts.commissionFor(opts.sessionId) : null;
  // Every caller path but a schedule's fire (inbound direct message, TUI and web fresh sessions,
  // team workers) is user-initiated.
  const scheduled = !!opts.scheduleId;
  await store.registerSession({
    sessionId: opts.sessionId,
    channel: opts.channel,
    backend: opts.backend,
    kind: scheduled ? 'scheduled' : 'local',
    origin: scheduled ? 'scheduled' : 'direct',
    projectId: opts.projectId,
    label: opts.label ?? null,
    profileName: opts.profileName ?? null,
    agentName: opts.agentName ?? null,
    browser: opts.browser ?? null,
    commissionId: commission?.commissionId ?? null,
    commissionDraft: commission?.commissionDraft ?? null,
    ...(opts.teamLeadId
      ? { teamLeadId: opts.teamLeadId, workerName: opts.workerName ?? null, workerBrief: opts.workerBrief ?? null }
      : {}),
    ...(scheduled ? { scheduleId: opts.scheduleId } : {}),
  });
}

export interface CreateDirectSessionDeps {
  sessionStore: SessionRegistryWriter;
  /** Bind the channel to the new session in the registry (so a later send resumes it). */
  setChannelSession(channel: string, sessionId: string): Promise<void>;
  /** Initialize the conversation ledger for the new channel/session. */
  initConversation(channel: string, opts: { sessionId: string; backend: string }): Promise<void>;
  /** Resolve the backend the send path will use for the channel (agent-runner reads the same). */
  resolveBackend(channel: string): string;
}

/** Create a fresh, live session for a web/UI conversation: mint a sessionId, derive its own
 *  `web:<sessionId>` conduit channel, register by ID, bind the channel→session mapping
 *  and conversation ledger. Returns the sessionId + channel. The session is
 *  user-initiated (origin='direct') unless `scheduleId` names the schedule whose fire opened it.
 *
 *  When `profileName` is provided, the backend is resolved directly from the profile config (not
 *  from the channel's profile state) so the session is bound to the correct backend even before any
 *  channel profile is set. The channel profile is then set so subsequent sends resolve correctly.
 *
 *  Because the channel is bound with the same backend the send path resolves, a subsequent send
 *  resumes THIS session rather than spawning a new one. */
export async function createDirectSession(
  deps: CreateDirectSessionDeps,
  opts: {
    projectId: string; sessionId?: string; profileName?: string | null; agentName?: string | null;
    selection?: { model?: string; provider?: string; thinking?: string; mode?: string } | null;
    browser?: SessionBrowserOption | null; commission?: CommissionCreateRequest | null;
    teamLeadId?: string | null; workerName?: string | null; workerBrief?: string | null;
    label?: string | null; scheduleId?: string | null;
  },
): Promise<{ sessionId: string; channel: string }> {
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const channel = `web:${sessionId}`;

  let backend: string;
  if (opts.profileName) {
    backend = resolveProfileConfig(opts.profileName).backend;
    setActiveProfile(opts.profileName, channel);
  } else {
    backend = deps.resolveBackend(channel);
  }

  // The draft composer's choice, carried onto the new channel before the first turn is routed —
  // through the SAME rule the picker writes with, not a direct state write. A draft has no history
  // to protect, but it can still name a level the backend does not take or a provider on a claude
  // profile: without the rule those land unchecked and the first turn dies at the CLI. The channel
  // is minted here, so the cross-backend guard has nothing to refuse.
  //
  // An EMPTY selection is a statement too — "run this profile as declared" — and it has to reach
  // the rule, because the rule is also what re-seeds `selectionDefault` (what the NEXT new
  // conversation opens on). Skipping it left a draft that had just been cleared back to its profile
  // re-opening the next one on the model it had dropped, however many times it was taken back.
  // `null`/`undefined` is the other thing entirely: a caller with no composer behind it
  // (sessions.create, an issue's session) states nothing and must not move the seed.
  if (opts.selection) {
    await applyChannelSelection({
      channel,
      model: opts.selection.model ?? null,
      provider: opts.selection.provider ?? null,
      thinking: opts.selection.thinking ?? null,
      mode: opts.selection.mode ?? null,
    });
  }

  // The environment the session opens in, written to the channel BEFORE the first turn is routed
  // (the run path resolves the agent per turn from the session record, then this map). No switch
  // rule is needed: a channel minted here has no history, so the cross-backend guard the rule
  // exists for has nothing to refuse.
  if (opts.agentName) setDefaultAgent(opts.agentName, channel);
  // Seeded on the same condition as the selection above: `selection` present is what marks a
  // composer behind this call, and a composer that named no agent stated the default.
  if (opts.selection) setSelectionDefaultAgent(opts.agentName ?? null);

  // settings.commissionEnabled is the feature's kill switch (on by default since DR-0037 v4).
  // Refuse here rather than downgrade: a caller that asked for a commission and silently got an
  // ordinary session would only discover it much later. This is the server-side backstop for every
  // create path; the UI hides the opt-in and the ui-service handlers reject earlier with a 400.
  if (opts.commission && !getSettings().commissionEnabled) {
    throw Object.assign(
      new Error('Commission mode is disabled; enable settings.commissionEnabled to use it'),
      { code: 'invalid-args' },
    );
  }

  await registerSessionRecord(deps.sessionStore, {
    sessionId,
    channel,
    backend,
    projectId: opts.projectId,
    label: opts.label ?? null,
    profileName: opts.profileName ?? null,
    agentName: opts.agentName ?? null,
    browser: opts.browser ?? null,
    commissionFor: opts.commission
      ? (id) => resolveCommissionCreate(opts.projectId, id, opts.commission!)
      : undefined,
    teamLeadId: opts.teamLeadId ?? null,
    workerName: opts.workerName ?? null,
    workerBrief: opts.workerBrief ?? null,
    scheduleId: opts.scheduleId ?? null,
  });
  await deps.setChannelSession(channel, sessionId);
  await deps.initConversation(channel, { sessionId, backend });
  return { sessionId, channel };
}

export interface AttachExistingSessionOpts {
  sessionId: string;
  backend: string;
  profileName?: string | null;
}

/** Attach a channel to an existing session: restore its profile (if any), bind the channel to it in
 *  the registry, and switch the conversation ledger. Mirrors the !resume switch sequence. */
export async function attachExistingSession(channel: string, opts: AttachExistingSessionOpts): Promise<void> {
  if (opts.profileName) setActiveProfile(opts.profileName, channel);
  await setSessionAsync(channel, opts.sessionId);
  await conversationLedger.switchSession(channel, {
    sessionId: opts.sessionId, backend: opts.backend, profileName: opts.profileName,
  });
}

export interface AdoptScheduledSessionStore {
  getById(sessionId: string): Promise<{
    channel: string; backend: string; origin: SessionOrigin; profileName: string | null;
  } | null>;
  /** Re-point the registry record: channel → the adopted channel, kind → local, origin → direct. */
  convertToDirect(sessionId: string, opts: { channel: string }): Promise<unknown | null>;
}

/** Convert a scheduled run's session into a normal direct web session (replying adopts the run).
 *  A run opened on its own `web:<sessionId>` conduit is already bound there and only needs its record
 *  re-pointed; an older run that lived on the shared project channel first gets that conduit attached
 *  — the same switch sequence as !resume, so a later send resumes the run's transcript. `scheduleId`
 *  is intentionally KEPT on the record (provenance for the trigger card / schedule grouping).
 *  Idempotent: a non-scheduled record just returns its current channel; an unknown id returns null. */
export async function adoptScheduledSession(
  store: AdoptScheduledSessionStore,
  sessionId: string,
): Promise<{ channel: string } | null> {
  const record = await store.getById(sessionId);
  if (!record) return null;
  if (record.origin !== 'scheduled') return { channel: record.channel };
  const channel = `web:${sessionId}`;
  // Re-attaching the conduit it already runs on would switch the ledger under a turn that may be live.
  if (record.channel !== channel) {
    await attachExistingSession(channel, {
      sessionId, backend: record.backend, profileName: record.profileName,
    });
  }
  await store.convertToDirect(sessionId, { channel });
  return { channel };
}

/** Clear a channel's session state: unbind the channel in the registry, clean session
 *  backups, and clear the conversation ledger. Mirrors the store-level half of !new. */
export async function resetChannelSession(channel: string): Promise<void> {
  const conv = await conversationLedger.getConversation(channel);
  if (conv) {
    sessionBackup.cleanupAllBackups(conv.sessionId);
    await conversationLedger.clearConversation(channel);
  }
  // One channel, one binding: `deleteSessionAsync` unbinds the channel in the registry.
  await deleteSessionAsync(channel).catch(() => {});
}
