// input:  message edits, ledger snapshots, PI path registry
// output: exact transcript rollback and reprocessing
// pos:    Platform message edit retry orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { registerPISessionPath } from '../../agent-adapter/index.js';
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
  registerPISessionPath?: (sessionId: string, sessionPath: string) => void;
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

interface EditRestoreState {
  backendSessionId: string | null;
  useSessionId: string | null;
  sessionName: string | null;
  restored: boolean;
  piSessionFile: string | null;
}

interface EditRestoreInput {
  channel: string;
  backend: string;
  turnIndex: number;
  targetBackupPath: string | null;
}

async function restoreFirstEditedTurn(
  input: EditRestoreInput,
  state: EditRestoreState,
): Promise<EditRestoreState> {
  let piSessionFile: string | null = null;
  if (input.backend === 'pi') {
    piSessionFile = input.targetBackupPath
      ? sessionBackup.sessionFileFromBackupPath(input.targetBackupPath, input.turnIndex)
      : state.backendSessionId ? await sessionBackup.findPISessionFile(state.backendSessionId) : null;
  }
  await deleteSessionAsync(input.channel, input.backend);
  return { ...state, useSessionId: null, sessionName: null, piSessionFile };
}

async function restoreEditedPISession(
  input: EditRestoreInput,
  state: EditRestoreState,
): Promise<EditRestoreState> {
  const restored = await restorePIEdit(
    state.backendSessionId, input.targetBackupPath, input.turnIndex,
  );
  const next = { ...state, restored: restored.restored, piSessionFile: restored.sessionFile };
  if (restored.restored) return next;
  log.warn('No backup found for PI session, falling back to new session');
  await deleteSessionAsync(input.channel, input.backend);
  return { ...next, useSessionId: null, sessionName: null };
}

async function restoreEditedClaudeSession(
  input: EditRestoreInput,
  state: EditRestoreState,
): Promise<EditRestoreState> {
  const restored = state.backendSessionId
    ? await sessionBackup.restoreBackup(state.backendSessionId, input.turnIndex)
    : false;
  if (restored) return { ...state, restored };
  log.warn('No backup found, falling back to new session');
  await deleteSessionAsync(input.channel, input.backend);
  return { ...state, restored, useSessionId: null, sessionName: null };
}

async function initialEditRestoreState(conversation: ChannelConversation): Promise<EditRestoreState> {
  const sessionId = conversation.sessionId;
  const sessionRecord = sessionId ? await sessionStore.getById(sessionId) : null;
  const backendSessionId = sessionRecord ? effectiveBackendSessionId(sessionRecord) : sessionId;
  return {
    backendSessionId, useSessionId: sessionId, sessionName: conversation.sessionName,
    restored: false, piSessionFile: null,
  };
}

async function restoreEditedSession(
  args: ProcessEditArgs,
  backend: string,
  targetBackupPath: string | null,
): Promise<EditRestoreState> {
  const state = await initialEditRestoreState(args.conversation);
  const input = { channel: args.channel, backend, turnIndex: args.turnIndex, targetBackupPath };
  if (args.turnIndex === 0) return restoreFirstEditedTurn(input, state);
  if (backend === 'pi') return restoreEditedPISession(input, state);
  return restoreEditedClaudeSession(input, state);
}

function stopActiveEdit(channel: string, activeAgents: RunningExecutions): void {
  if (!activeAgents.hasChannel(channel)) return;
  supersededEdits.mark(channel);
  activeAgents.supersedeByChannel(channel, 'edit');
  conduitQueues.delete(channel);
  log.info('Killed active process for edit retry');
}

interface EditRollback {
  targetBackupPath: string | null;
  supersededStatusTimestamps: string[];
}

async function rollbackEditedTurn(args: ProcessEditArgs): Promise<EditRollback | null> {
  const result = await conversationLedger.rollbackTo(args.channel, args.turnIndex);
  if (!result) {
    log.error('Rollback failed — no conversation found');
    return null;
  }
  const targetBackupPath = result.supersededTurns.find((turn) => turn.turnIndex === args.turnIndex)?.backupPath
    ?? args.conversation.turns[args.turnIndex]?.backupPath
    ?? null;
  const supersededStatusTimestamps = await cleanupSupersededMessages(
    result.supersededTurns, args.channel, args.adapter,
  );
  return { targetBackupPath, supersededStatusTimestamps };
}

function registerRestoredEditPath(
  backend: string,
  state: EditRestoreState,
  register: (sessionId: string, sessionPath: string) => void,
): void {
  if (backend !== 'pi' || !state.restored || !state.backendSessionId || !state.piSessionFile) return;
  register(state.backendSessionId, state.piSessionFile);
}

function cleanupEditedSession(backend: string, turnIndex: number, state: EditRestoreState): void {
  if (backend !== 'pi') {
    sessionBackup.cleanupBackupsAfter(state.backendSessionId ?? '', turnIndex);
    return;
  }
  if (state.piSessionFile && state.restored) {
    sessionBackup.cleanupBackupsForFile(state.piSessionFile, turnIndex);
  } else if (state.piSessionFile) {
    sessionBackup.cleanupAllBackupsForFile(state.piSessionFile);
  }
}

async function processEditLocked(args: ProcessEditArgs): Promise<void> {
  const { channel, originalTs, newText, turnIndex, deps } = args;
  const backend = (deps.resolveBackend ?? resolveBackendForChannel)(channel) || args.conversation.backend;
  stopActiveEdit(channel, deps.activeAgents);
  const rollback = await rollbackEditedTurn(args);
  if (!rollback) return;
  const state = await restoreEditedSession(args, backend, rollback.targetBackupPath);
  registerRestoredEditPath(backend, state, deps.registerPISessionPath ?? registerPISessionPath);
  deps.closePooledSession?.(channel, backend);
  await conversationLedger.truncateTurns(channel, turnIndex);
  cleanupEditedSession(backend, turnIndex, state);
  deps.reprocessMessage(channel, newText, args.adapter, {
    originalTs, isRetry: true, sessionId: state.useSessionId,
    sessionName: state.sessionName,
    supersededStatusTimestamps: rollback.supersededStatusTimestamps,
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
