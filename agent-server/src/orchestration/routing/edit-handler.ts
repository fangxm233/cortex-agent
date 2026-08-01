// input:  message edits, ledger snapshots, active runs
// output: immutable rollback restore and reprocessing
// pos:    Platform message edit retry orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import type { PlatformAdapter, MessageEditContext } from '@platform/index.js';
import type { LedgerTurn, ChannelConversation } from '@store/conversation-ledger-repo.js';
import { effectiveBackendSessionId, sessionStore } from '@store/session-registry-repo.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import * as sessionBackup from '@domain/sessions/session-backup.js';
import { deleteSessionAsync } from '@domain/sessions/session.js';
import { resolveBackendForChannel } from '@domain/agents/index.js';
import type { RunningExecutions } from '../../core/running-executions.js';
import { conduitQueues } from '../conduit-queue.js';
import { supersededEdits } from '../superseded-edits.js';
import { isTurnTrackingPending, markPendingTurnSuperseded, waitForTurnTracking } from '../lifecycle.js';
import { acquireTurnMutationLock } from '../turn-mutation-lock.js';

const log = createLogger('edit-handler');

const DEBOUNCE_MS = 500;

// Per-channel debounce timers for rapid edits
const pendingEdits = new Map();

/**
 * Create an edit handler with injected app-level dependencies.
 *
 * @param deps.activeAgents - ActiveAgents singleton for per-channel handle registry
 * @param deps.reprocessMessage - function(channel, text, client, opts) to re-process a message as a retry
 * @param deps.closePooledSession - tear down any pooled agent process for the channel before
 *   reprocessing. Required for Claude backend, whose CLI runs in stream-json mode and keeps
 *   the conversation in memory; without an explicit close the new turn appends to stale state
 *   and ignores the freshly-restored JSONL.
 */
function createEditHandler(deps: {
  activeAgents: RunningExecutions;
  reprocessMessage: (channel: string, text: string, adapter: PlatformAdapter, opts: {
    originalTs: string;
    isRetry: boolean;
    sessionId: string | null;
    sessionName: string | null;
    supersededStatusTimestamps?: string[];
  }) => void;
  closePooledSession?: (channel: string, backend: string) => void;
  isTurnTrackingPending?: (channel: string) => boolean;
  markPendingTurnSuperseded?: (channel: string) => void;
  waitForTurnTracking?: (channel: string) => Promise<void>;
  resolveBackend?: (channel: string) => string;
}) {
  return async function handleMessageEdit(ctx: MessageEditContext, adapter: PlatformAdapter) {
    const { originalRef, newText } = ctx;
    const channel = originalRef.conduit;
    const originalTs = originalRef.messageId;

    log.info('Message edited:', { channel, ts: originalTs, new: newText?.substring(0, 40) });

    // Look up the original processing record
    const found = await conversationLedger.findTurn(channel, originalTs);
    if (!found) {
      log.info('No ledger record for edited message, ignoring');
      return;
    }

    // Debounce: if another edit comes within 500ms, cancel the previous timer
    const debounceKey = `${channel}:${originalTs}`;
    if (pendingEdits.has(debounceKey)) {
      clearTimeout(pendingEdits.get(debounceKey));
    }

    pendingEdits.set(debounceKey, setTimeout(async () => {
      pendingEdits.delete(debounceKey);

      try {
        await processEdit({
          channel,
          adapter,
          originalTs,
          newText,
          turnIndex: found.turnIndex,
          conversation: found.conversation,
          deps,
        });
      } catch (e) {
        log.error('Error processing edit:', (e as Error).message);
      }
    }, DEBOUNCE_MS));
  };
}

interface ProcessEditArgs {
  channel: string;
  adapter: PlatformAdapter;
  originalTs: string;
  newText: string;
  turnIndex: number;
  conversation: ChannelConversation;
  deps: Parameters<typeof createEditHandler>[0];
}

async function processEdit(args: ProcessEditArgs): Promise<void> {
  const snapshotPending = args.deps.isTurnTrackingPending ?? isTurnTrackingPending;
  if (snapshotPending(args.channel)) {
    (args.deps.markPendingTurnSuperseded ?? markPendingTurnSuperseded)(args.channel);
    await (args.deps.waitForTurnTracking ?? waitForTurnTracking)(args.channel);
  }
  const releaseMutation = await acquireTurnMutationLock(args.channel);
  try {
    await processEditLocked(args);
  } finally {
    releaseMutation();
  }
}

interface PIEditRestore {
  restored: boolean;
  sessionFile: string | null;
}

async function restorePIEdit(
  backendSessionId: string | null,
  backupPath: string | null,
  turnIndex: number,
): Promise<PIEditRestore> {
  const recordedFile = backupPath
    ? sessionBackup.sessionFileFromBackupPath(backupPath, turnIndex)
    : null;
  const sessionFile = backupPath || !backendSessionId
    ? recordedFile
    : await sessionBackup.findPISessionFile(backendSessionId);
  const restored = backupPath
    ? await sessionBackup.restoreSessionBackup(backupPath, turnIndex)
    : sessionFile ? await sessionBackup.restoreSessionFile(sessionFile, turnIndex) : false;
  return { restored, sessionFile };
}

async function processEditLocked({ channel, adapter, originalTs, newText, turnIndex, conversation, deps }: ProcessEditArgs): Promise<void> {
  const { activeAgents, reprocessMessage, closePooledSession } = deps;
  const backend = (deps.resolveBackend ?? resolveBackendForChannel)(channel) || conversation.backend;

  if (activeAgents.hasChannel(channel)) {
    supersededEdits.mark(channel);
    activeAgents.supersedeByChannel(channel, 'edit');
    conduitQueues.delete(channel);
    log.info('Killed active process for edit retry');
  }

  // Step 2: Rollback — mark all turns from editedTurnIndex onward as superseded
  const rollbackResult = await conversationLedger.rollbackTo(channel, turnIndex);
  if (!rollbackResult) {
    log.error('Rollback failed — no conversation found');
    return;
  }

  const { supersededTurns } = rollbackResult;
  const targetBackupPath = supersededTurns.find((turn) => turn.turnIndex === turnIndex)?.backupPath
    ?? conversation.turns[turnIndex]?.backupPath
    ?? null;

  // Step 3: Delete old response messages + collect superseded status ts for permalink backfill
  const supersededStatusTimestamps = await cleanupSupersededMessages(supersededTurns, channel, adapter);

  // Step 4: Restore session backup
  const sessionId = conversation.sessionId;
  const sessionRecord = sessionId ? await sessionStore.getById(sessionId) : null;
  const backendSessionId = sessionRecord ? effectiveBackendSessionId(sessionRecord) : sessionId;
  let useSessionId = sessionId;
  let sessionName = conversation.sessionName;
  let restored = false;
  let piSessionFile: string | null = null;

  if (turnIndex === 0) {
    if (backend === 'pi') {
      piSessionFile = targetBackupPath
        ? sessionBackup.sessionFileFromBackupPath(targetBackupPath, turnIndex)
        : backendSessionId ? await sessionBackup.findPISessionFile(backendSessionId) : null;
    }
    await deleteSessionAsync(channel, backend);
    useSessionId = null;
    sessionName = null;
  } else if (backend === 'pi') {
    const piRestore = await restorePIEdit(backendSessionId, targetBackupPath, turnIndex);
    restored = piRestore.restored;
    piSessionFile = piRestore.sessionFile;
    if (!restored) {
      log.warn('No backup found for PI session, falling back to new session');
      await deleteSessionAsync(channel, backend);
      useSessionId = null;
      sessionName = null;
    }
  } else {
    restored = backendSessionId ? await sessionBackup.restoreBackup(backendSessionId, turnIndex) : false;
    if (!restored) {
      log.warn('No backup found, falling back to new session');
      await deleteSessionAsync(channel, backend);
      useSessionId = null;
      sessionName = null;
    }
  }

  // Step 4.5: Tear down any pooled agent process for this channel BEFORE reprocessing.
  // Claude CLI runs in stream-json mode as a long-lived process and keeps the conversation
  // in memory; restoring the JSONL on disk is a no-op unless we kill that process so the
  // next runAgent spawns a fresh one with `--resume <sessionId>`. Without this, the
  // edited message is appended as turn N+1 instead of replacing turn N — the symptom the
  // user reported. PI spawns a new subprocess per turn, so close is a no-op for it
  // (the wiring still calls through but the function-level no-ops handle that branch).
  closePooledSession?.(channel, backend);

  // Step 5: Cleanup — remove superseded turns from ledger and invalidated backups
  await conversationLedger.truncateTurns(channel, turnIndex);
  if (backend === 'pi') {
    if (piSessionFile && restored) sessionBackup.cleanupBackupsForFile(piSessionFile, turnIndex);
    else if (piSessionFile) sessionBackup.cleanupAllBackupsForFile(piSessionFile);
  } else {
    sessionBackup.cleanupBackupsAfter(backendSessionId ?? '', turnIndex);
  }

  // Step 6: Re-enqueue the edited message for processing
  reprocessMessage(channel, newText, adapter, {
    originalTs,
    isRetry: true,
    sessionId: useSessionId,
    sessionName,
    supersededStatusTimestamps,
  });
}

/**
 * Delete response messages and update status messages for superseded turns.
 * Returns the status message timestamps for permalink backfill by reprocessMessage.
 */
async function cleanupSupersededMessages(supersededTurns: LedgerTurn[], channel: string, adapter: PlatformAdapter): Promise<string[]> {
  const promises = [];
  const supersededStatusTimestamps: string[] = [];

  for (const turn of supersededTurns) {
    for (const ts of turn.responseMessageTimestamps) {
      promises.push(
        adapter.deleteMessage({ conduit: channel, messageId: ts }).catch((e) => {
          log.warn('Failed to delete message:', ts, (e as Error).message);
        })
      );
    }

    if (turn.statusMessageTs) {
      supersededStatusTimestamps.push(turn.statusMessageTs);
      promises.push(
        adapter.updateMessage(
          { conduit: channel, messageId: turn.statusMessageTs },
          { text: `${Icons.superseded} Superseded by edit` },
        ).catch(() => {})
      );
    }
  }

  await Promise.allSettled(promises);
  return supersededStatusTimestamps;
}

export { createEditHandler };
