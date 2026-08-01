// input:  rewind request, ledger snapshots, PI path registry
// output: exact transcript restore and admitted resend result
// pos:    Web message edit rollback orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { registerPISessionPath } from '../agent-adapter/index.js';
import type { PlatformAdapter } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { runningExecutions } from '@core/running-executions.js';
import { conversationLedger, type ChannelConversation, type LedgerTurn } from '@store/conversation-ledger-repo.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { sessionStore, effectiveBackendSessionId, type Session } from '@store/session-registry-repo.js';
import * as sessionBackup from '@domain/sessions/session-backup.js';
import { resolveBackendForChannel, closeSession as closeClaudePooledSession } from '@domain/agents/index.js';
import { publishSessionRewound } from './session-events.js';
import { sendWebUserMessage } from './session-send.js';
import { isTurnTrackingPending } from './lifecycle.js';
import { tryAcquireTurnMutationLock } from './turn-mutation-lock.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';

const log = createLogger('session-rewind');

export type RewindResult = { ok: true } | { ok: false; reason: 'running' | 'not-found' };

/** Injectable dependency surface (unit tests). Defaults bind the production singletons. */
export interface RewindDeps {
  activeAgents: { hasChannel(channel: string): boolean };
  snapshotPending(channel: string): boolean;
  tryAcquireMutation(channel: string): (() => void) | null;
  ledger: {
    getConversation(channel: string): Promise<ChannelConversation | null>;
    rollbackTo(channel: string, turnIndex: number): Promise<{ supersededTurns: LedgerTurn[]; conversation: ChannelConversation } | null>;
    truncateTurns(channel: string, fromIndex: number): Promise<void>;
  };
  history: {
    truncateFromTurn(sessionId: string, turnIndex: number): Promise<{ text: string; ts: string; attachments?: AttachmentMeta[] } | null>;
    appendEditMarker(sessionId: string, opts: { originalText: string; originalTs: string }): Promise<void>;
  };
  sessionStore: {
    getById(sessionId: string): Promise<Session | null>;
    updateSession(name: string, updates: { backendSessionId: string | null }): Promise<void>;
  };
  backup: Pick<typeof sessionBackup,
    'restoreBackup' | 'cleanupBackupsAfter' | 'cleanupAllBackups' |
    'findPISessionFile' | 'restoreSessionFile' | 'restoreSessionBackup' |
    'sessionFileFromBackupPath' | 'cleanupBackupsForFile' | 'cleanupAllBackupsForFile'
  >;
  resolveBackend: (channel: string) => string;
  registerPISessionPath: (sessionId: string, sessionPath: string) => void;
  closePooledSession: (channel: string, backend: string) => void;
  send: (opts: {
    channel: string;
    text: string;
    attachments?: AttachmentMeta[];
    adapter: PlatformAdapter;
    mutationRelease?: () => void;
  }) => void;
  publishRewound: (payload: { sessionId: string; channel: string; turnIndex: number }) => void;
}

function defaultDeps(): RewindDeps {
  return {
    activeAgents: runningExecutions,
    snapshotPending: isTurnTrackingPending,
    tryAcquireMutation: tryAcquireTurnMutationLock,
    ledger: conversationLedger,
    history: conversationHistory,
    sessionStore,
    backup: sessionBackup,
    resolveBackend: (channel) => resolveBackendForChannel(channel),
    registerPISessionPath,
    closePooledSession: (channel, backend) => { if (backend === 'claude') closeClaudePooledSession(channel); },
    send: sendWebUserMessage,
    publishRewound: publishSessionRewound,
  };
}

/**
 * Edit a previously-sent user message and rewind the conversation to it: every turn from
 * `turnIndex` onward is rolled back (ledger + backend session jsonl + display history), then the
 * edited `text` is re-sent as a genuine user turn (original attachments preserved). Fire-and-forget
 * on the regeneration — the new reply streams over `session.message` as usual.
 *
 * Rejected while a run is live on the channel ('running' — the UI greys the edit action out too)
 * and when the session/turn cannot be found ('not-found').
 */
export async function rewindWebSession(
  opts: { sessionId: string; channel: string; turnIndex: number; text: string; adapter: PlatformAdapter },
  deps: RewindDeps = defaultDeps(),
): Promise<RewindResult> {
  if (deps.snapshotPending(opts.channel)) return { ok: false, reason: 'running' };
  let releaseMutation = deps.tryAcquireMutation(opts.channel);
  if (!releaseMutation) return { ok: false, reason: 'running' };
  try {
    const result = await rewindLocked(opts, deps, releaseMutation);
    if (result.ok) releaseMutation = null;
    return result;
  } finally {
    releaseMutation?.();
  }
}

interface SnapshotRestore {
  restored: boolean;
  piSessionFile: string | null;
}

async function restoreSnapshot(
  backend: string,
  backendSessionId: string | null,
  backupPath: string | null,
  turnIndex: number,
  backup: RewindDeps['backup'],
): Promise<SnapshotRestore> {
  if (backend !== 'pi') {
    const restored = turnIndex > 0 && backendSessionId
      ? await backup.restoreBackup(backendSessionId, turnIndex)
      : false;
    return { restored, piSessionFile: null };
  }
  const recordedFile = backupPath
    ? backup.sessionFileFromBackupPath(backupPath, turnIndex)
    : null;
  const piSessionFile = backupPath || !backendSessionId
    ? recordedFile
    : await backup.findPISessionFile(backendSessionId);
  if (turnIndex === 0 || !backendSessionId) return { restored: false, piSessionFile };
  const restored = backupPath
    ? await backup.restoreSessionBackup(backupPath, turnIndex)
    : piSessionFile ? await backup.restoreSessionFile(piSessionFile, turnIndex) : false;
  return { restored, piSessionFile };
}

function registerRestoredPIPath(
  backend: string,
  backendSessionId: string | null,
  snapshot: SnapshotRestore,
  register: RewindDeps['registerPISessionPath'],
): void {
  if (backend !== 'pi' || !backendSessionId || !snapshot.restored || !snapshot.piSessionFile) return;
  register(backendSessionId, snapshot.piSessionFile);
}

function cleanupSnapshot(
  backend: string,
  backendSessionId: string | null,
  turnIndex: number,
  snapshot: SnapshotRestore,
  backup: RewindDeps['backup'],
): void {
  if (backend === 'pi') {
    if (!snapshot.piSessionFile) return;
    if (snapshot.restored) backup.cleanupBackupsForFile(snapshot.piSessionFile, turnIndex);
    else backup.cleanupAllBackupsForFile(snapshot.piSessionFile);
    return;
  }
  if (!backendSessionId) return;
  if (snapshot.restored) backup.cleanupBackupsAfter(backendSessionId, turnIndex);
  else backup.cleanupAllBackups(backendSessionId);
}

interface RewindContext {
  conversation: ChannelConversation;
  session: Session;
  backend: string;
  backendSessionId: string | null;
}

async function resolveRewindContext(
  opts: { sessionId: string; channel: string; turnIndex: number },
  deps: RewindDeps,
): Promise<RewindContext | null> {
  const conversation = await deps.ledger.getConversation(opts.channel);
  if (!conversation || opts.turnIndex < 0 || opts.turnIndex >= conversation.turns.length) return null;
  const session = await deps.sessionStore.getById(opts.sessionId);
  if (!session) return null;
  const backend = deps.resolveBackend(opts.channel) || conversation.backend;
  return { conversation, session, backend, backendSessionId: effectiveBackendSessionId(session) };
}

async function restoreRewindBackend(
  context: RewindContext,
  channel: string,
  turnIndex: number,
  deps: RewindDeps,
): Promise<void> {
  await deps.ledger.rollbackTo(channel, turnIndex);
  const backupPath = context.conversation.turns[turnIndex].backupPath;
  const snapshot = await restoreSnapshot(
    context.backend, context.backendSessionId, backupPath, turnIndex, deps.backup,
  );
  registerRestoredPIPath(context.backend, context.backendSessionId, snapshot, deps.registerPISessionPath);
  if (!snapshot.restored) {
    if (turnIndex > 0) log.warn('No backup found — starting a fresh backend session (display history keeps earlier turns)');
    await deps.sessionStore.updateSession(context.session.name, { backendSessionId: null });
  }
  deps.closePooledSession(channel, context.backend);
  await deps.ledger.truncateTurns(channel, turnIndex);
  cleanupSnapshot(context.backend, context.backendSessionId, turnIndex, snapshot, deps.backup);
}

async function resendRewoundTurn(
  opts: { sessionId: string; channel: string; turnIndex: number; text: string; adapter: PlatformAdapter },
  conversation: ChannelConversation,
  deps: RewindDeps,
  mutationRelease: () => void,
): Promise<void> {
  const removed = await deps.history.truncateFromTurn(opts.sessionId, opts.turnIndex);
  const originalText = removed?.text ?? conversation.turns[opts.turnIndex]?.userMessageText ?? '';
  await deps.history.appendEditMarker(opts.sessionId, {
    originalText, originalTs: removed?.ts ?? '',
  });
  deps.publishRewound({ sessionId: opts.sessionId, channel: opts.channel, turnIndex: opts.turnIndex });
  deps.send({
    channel: opts.channel, text: opts.text, attachments: removed?.attachments,
    adapter: opts.adapter, mutationRelease,
  });
}

async function rewindLocked(
  opts: { sessionId: string; channel: string; turnIndex: number; text: string; adapter: PlatformAdapter },
  deps: RewindDeps,
  mutationRelease: () => void,
): Promise<RewindResult> {
  if (deps.activeAgents.hasChannel(opts.channel)) return { ok: false, reason: 'running' };
  const context = await resolveRewindContext(opts, deps);
  if (!context) return { ok: false, reason: 'not-found' };
  log.info('Rewinding session:', { channel: opts.channel, turnIndex: opts.turnIndex, backend: context.backend });
  await restoreRewindBackend(context, opts.channel, opts.turnIndex, deps);
  await resendRewoundTurn(opts, context.conversation, deps, mutationRelease);
  return { ok: true };
}
