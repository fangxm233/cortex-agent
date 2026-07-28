// input:  Slack message_changed events, orch/active-agents, orch/channel-queue, orch/superseded-edits, ledger, session-backup
// output: createEditHandler factory
// pos:    Slack message edit detection and session rollback retry orchestration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { PlatformAdapter, MessageEditContext } from '@platform/index.js';
import type { LedgerTurn, ChannelConversation } from '@store/conversation-ledger-repo.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import * as sessionBackup from '@domain/sessions/session-backup.js';
import { deleteSessionAsync } from '@domain/sessions/session.js';
import { resolveBackendForChannel } from '@domain/agents/index.js';
import type { RunningExecutions } from '../../core/running-executions.js';
import { conduitQueues } from '../conduit-queue.js';
import { supersededEdits } from '../superseded-edits.js';

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

async function processEdit({ channel, adapter, originalTs, newText, turnIndex, conversation, deps }: { channel: string; adapter: PlatformAdapter; originalTs: string; newText: string; turnIndex: number; conversation: ChannelConversation; deps: Parameters<typeof createEditHandler>[0] }): Promise<void> {
  const { activeAgents, reprocessMessage, closePooledSession } = deps;

  // Resolve the *effective* backend for this channel. conversation.backend was captured at
  // initTurnTracking time using the global activeBackend, which doesn't honor channel
  // profiles — a channel running profile `execute` (backend=pi) but global backend=claude
  // would otherwise be routed to the Claude restore branch and miss the PI backup file.
  // resolveBackendForChannel reads the channel's profile and falls back to global if absent.
  const backend = resolveBackendForChannel(channel) || conversation.backend;

  // Step 1: Cancel any active processing on this channel
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

  // Step 3: Delete old response messages + collect superseded status ts for permalink backfill
  const supersededStatusTimestamps = await cleanupSupersededMessages(supersededTurns, channel, adapter);

  // Step 4: Restore session backup
  const sessionId = conversation.sessionId;
  let useSessionId = sessionId;
  let sessionName = conversation.sessionName;

  if (turnIndex === 0) {
    // Editing the first message — no prior context to preserve
    await deleteSessionAsync(channel, backend);
    useSessionId = null;
    sessionName = null;
  } else if (backend === 'pi') {
    // PI: restore via file-path-based backup + switch_session on next spawn
    const piFile = sessionId ? sessionBackup.findPISessionFile(sessionId) : null;
    const restored = piFile ? sessionBackup.restoreSessionFile(piFile, turnIndex) : false;
    if (!restored) {
      log.warn('No backup found for PI session, falling back to new session');
      await deleteSessionAsync(channel, backend);
      useSessionId = null;
      sessionName = null;
    }
  } else {
    // Claude / other backends: restore via sessionId-based backup
    const restored = sessionId ? sessionBackup.restoreBackup(sessionId, turnIndex) : false;
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
  if (backend === 'pi' && sessionId) {
    const piFile = sessionBackup.findPISessionFile(sessionId);
    if (piFile) sessionBackup.cleanupBackupsForFile(piFile, turnIndex);
  } else {
    sessionBackup.cleanupBackupsAfter(sessionId ?? '', turnIndex);
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
