// input:  rewind request, ledger snapshots, mutation lease
// output: immutable restore and admitted resend result
// pos:    Web message edit rollback orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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

async function rewindLocked(
  opts: { sessionId: string; channel: string; turnIndex: number; text: string; adapter: PlatformAdapter },
  deps: RewindDeps,
  mutationRelease: () => void,
): Promise<RewindResult> {
  const { sessionId, channel, turnIndex, text, adapter } = opts;
  if (deps.activeAgents.hasChannel(channel)) return { ok: false, reason: 'running' };

  const conv = await deps.ledger.getConversation(channel);
  if (!conv || turnIndex < 0 || turnIndex >= conv.turns.length) return { ok: false, reason: 'not-found' };

  const rec = await deps.sessionStore.getById(sessionId);
  if (!rec) return { ok: false, reason: 'not-found' };
  const backendSessionId = effectiveBackendSessionId(rec);
  const backend = deps.resolveBackend(channel) || conv.backend;

  log.info('Rewinding session:', { channel, turnIndex, backend });

  const backupPath = conv.turns[turnIndex].backupPath;

  // 1. Ledger: mark turns from turnIndex onward superseded.
  await deps.ledger.rollbackTo(channel, turnIndex);

  // 2. Restore the immutable pre-turn snapshot. Legacy turns without backupPath retain the
  // filename-discovery fallback; a recorded PI path is never replaced by a newer filename.
  const snapshot = await restoreSnapshot(
    backend, backendSessionId, backupPath, turnIndex, deps.backup,
  );
  if (!snapshot.restored) {
    if (turnIndex > 0) log.warn('No backup found — starting a fresh backend session (display history keeps earlier turns)');
    await deps.sessionStore.updateSession(rec.name, { backendSessionId: null });
  }

  // 3. Kill any pooled CLI process — an alive stream-json Claude keeps the old conversation in
  //    memory and would ignore the restored jsonl on disk.
  deps.closePooledSession(channel, backend);

  // 4. Ledger + backup cleanup for the superseded range.
  await deps.ledger.truncateTurns(channel, turnIndex);
  cleanupSnapshot(backend, backendSessionId, turnIndex, snapshot, deps.backup);

  // 5. Display history: drop the edited turn and everything after; remember the original message.
  const removed = await deps.history.truncateFromTurn(sessionId, turnIndex);
  const originalText = removed?.text ?? conv.turns[turnIndex]?.userMessageText ?? '';
  await deps.history.appendEditMarker(sessionId, { originalText, originalTs: removed?.ts ?? '' });

  // 6. Tell live clients the transcript changed shape (they drop their live tails + refetch).
  deps.publishRewound({ sessionId, channel, turnIndex });

  // 7. Re-send the edited text as a genuine user turn (original attachments preserved —
  //    the edit UI cannot add or remove them).
  deps.send({
    channel, text, attachments: removed?.attachments, adapter, mutationRelease,
  });

  return { ok: true };
}
