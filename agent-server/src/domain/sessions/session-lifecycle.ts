import * as crypto from 'node:crypto';
import { setSessionAsync, deleteSessionAsync } from './session.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { applyChannelSelection } from '@domain/agents/model-selection.js';
import { setChannelSelection, setDefaultAgent, setSelectionDefaultAgent } from '@domain/agents/config.js';
import { resolveRunSelection } from '@domain/runs/config-resolver.js';
import type { EngineSelection } from '@domain/agents/engine-selection.js';
import type { SessionOrigin } from '@store/session-registry-repo.js';
import { shortSessionId } from '@core/short-session-id.js';
import { createWorkspace } from '@core/workspace.js';

export interface SessionRegistryWriter {
  registerSession(opts: {
    sessionId: string; channel: string; backend: string;
    kind: 'local' | 'scheduled'; origin?: SessionOrigin; projectId: string;
    label?: string | null; selection?: EngineSelection | null; agentName?: string | null;
    boardId?: string | null;
    teamLeadId?: string | null; workerName?: string | null; workerBrief?: string | null;
    scheduleId?: string | null;
    clean?: boolean; workspaceDir?: string | null;
  }): Promise<void>;
}

export interface RegisterSessionRecordOpts {
  sessionId: string;
  channel: string;
  backend: string;
  projectId: string;
  label?: string | null;
  selection?: EngineSelection | null;
  /** The agent template; absent means the channel/global default. */
  agentName?: string | null;
  boardId?: string | null;
  teamLeadId?: string | null;
  workerName?: string | null;
  workerBrief?: string | null;
  /** Provenance retained when the user adopts a scheduled session. */
  scheduleId?: string | null;
  clean?: boolean;
  workspaceDir?: string | null;
}

/** Register a session by its stable ID, freezing the engine choice for future resumes. */
export async function registerSessionRecord(store: SessionRegistryWriter, opts: RegisterSessionRecordOpts): Promise<void> {
  const scheduled = !!opts.scheduleId;
  const selection = resolveRunSelection({ channel: opts.channel, selection: opts.selection });
  await store.registerSession({
    sessionId: opts.sessionId, channel: opts.channel, backend: selection.backend,
    kind: scheduled ? 'scheduled' : 'local', origin: scheduled ? 'scheduled' : 'direct',
    projectId: opts.projectId, label: opts.label ?? null, selection,
    agentName: opts.agentName ?? null, boardId: opts.boardId ?? null,
    ...(opts.teamLeadId
      ? { teamLeadId: opts.teamLeadId, workerName: opts.workerName ?? null, workerBrief: opts.workerBrief ?? null }
      : {}),
    ...(scheduled ? { scheduleId: opts.scheduleId } : {}),
    ...(opts.clean ? { clean: true, workspaceDir: opts.workspaceDir ?? null } : {}),
  });
}

export interface CreateDirectSessionDeps {
  sessionStore: SessionRegistryWriter;
  setChannelSession(channel: string, sessionId: string): Promise<void>;
  initConversation(channel: string, opts: { sessionId: string; backend: string; selection: EngineSelection }): Promise<void>;
  resolveBackend(channel: string): string;
}

interface CreateDirectSessionOpts {
  projectId: string; sessionId?: string; agentName?: string | null;
  selection?: EngineSelection | null;
  seedDefault?: boolean;
  boardId?: string | null;
  teamLeadId?: string | null; workerName?: string | null; workerBrief?: string | null;
  label?: string | null; scheduleId?: string | null;
  /** Clean mode: run the session in its own workspace without Cortex context. */
  clean?: boolean;
}

/** A draft's explicit selection goes through the picker rule before the channel is bound. */
async function initializeSelection(channel: string, opts: CreateDirectSessionOpts): Promise<EngineSelection> {
  const selection = resolveRunSelection({ channel, selection: opts.selection });
  const seedDefault = opts.seedDefault ?? !!opts.selection;
  const applied = await applyChannelSelection({ channel, ...selection, seedDefault });
  if (!applied.ok) throw new Error(applied.reason ?? 'Invalid engine selection');
  if (opts.agentName) setDefaultAgent(opts.agentName, channel);
  if (seedDefault) setSelectionDefaultAgent(opts.agentName ?? null);
  return selection;
}

/** Mint a session and bind its conduit, registry and ledger to one materialized engine choice. */
export async function createDirectSession(
  deps: CreateDirectSessionDeps,
  opts: CreateDirectSessionOpts,
): Promise<{ sessionId: string; channel: string }> {
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const channel = `web:${sessionId}`;
  const selection = await initializeSelection(channel, opts);
  // The folder is the session's cwd for life: Claude finds its transcript by cwd, so it is made
  // once, here, and never moves.
  const workspaceDir = opts.clean ? createWorkspace(shortSessionId(sessionId)) : null;
  await registerSessionRecord(deps.sessionStore, {
    ...opts, sessionId, channel, backend: selection.backend, selection, workspaceDir,
  });
  await deps.setChannelSession(channel, sessionId);
  await deps.initConversation(channel, { sessionId, backend: selection.backend, selection });
  return { sessionId, channel };
}

export interface AttachExistingSessionOpts {
  sessionId: string;
  backend: string;
  selection?: EngineSelection | null;
}

/** Resume restores the record verbatim, not the last choice of the channel it replaces. */
export async function attachExistingSession(channel: string, opts: AttachExistingSessionOpts): Promise<void> {
  const selection = resolveRunSelection({ channel, selection: opts.selection });
  // This restores another session rather than switching the engine of the current session.
  setChannelSelection(channel, selection);
  await setSessionAsync(channel, opts.sessionId);
  await conversationLedger.switchSession(channel, {
    sessionId: opts.sessionId, backend: selection.backend, selection,
  });
}

export interface AdoptScheduledSessionStore {
  getById(sessionId: string): Promise<{
    channel: string; backend: string; origin: SessionOrigin; selection: EngineSelection | null;
  } | null>;
  convertToDirect(sessionId: string, opts: { channel: string }): Promise<unknown | null>;
}

/** Re-home older shared-channel scheduled runs; preserve provenance and engine selection. */
export async function adoptScheduledSession(
  store: AdoptScheduledSessionStore,
  sessionId: string,
): Promise<{ channel: string } | null> {
  const record = await store.getById(sessionId);
  if (!record) return null;
  if (record.origin !== 'scheduled') return { channel: record.channel };
  const channel = `web:${sessionId}`;
  if (record.channel !== channel) {
    await attachExistingSession(channel, {
      sessionId, backend: record.backend, selection: record.selection,
    });
  }
  await store.convertToDirect(sessionId, { channel });
  return { channel };
}

/** Clear the channel's binding and conversation ledger. */
export async function resetChannelSession(channel: string): Promise<void> {
  const conv = await conversationLedger.getConversation(channel);
  if (conv) await conversationLedger.clearConversation(channel);
  await deleteSessionAsync(channel).catch(() => {});
}
