import { engines } from '@domain/runs/engines.js';
import type { PlatformAdapter, MessageEditContext } from '@platform/index.js';
import type { LedgerTurn, ChannelConversation } from '@store/conversation-ledger-repo.js';
import { effectiveBackendSessionId, sessionStore } from '@store/session-registry-repo.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { deleteSessionAsync } from '@domain/sessions/session.js';
import { resolveBackendForChannel } from '@domain/agents/index.js';
import type { RunRegistry } from '../../core/run-registry.js';
import { conduitQueues } from '../conduit-queue.js';
import { activeTurns } from '../turn/active-turns.js';
import { acquireTurnMutationLock } from '../turn-mutation-lock.js';
import { applyRestore, planRestore, transcriptCutter, type RestorePlan } from '../rewind-restore.js';
import { t } from '@core/i18n.js';

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
  activeAgents: RunRegistry;
  reprocessMessage: (channel: string, text: string, adapter: PlatformAdapter, opts: {
    originalTs: string;
    sessionId: string | null;
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
  const snapshotPending = args.deps.isTurnTrackingPending ?? ((c: string) => activeTurns.trackingPending(c));
  if (snapshotPending(args.channel)) {
    (args.deps.markPendingTurnSuperseded ?? ((c: string) => activeTurns.markTrackingSuperseded(c)))(args.channel);
    await (args.deps.waitForTurnTracking ?? ((c: string) => activeTurns.waitForTracking(c)))(args.channel);
  }
  const releaseMutation = await acquireTurnMutationLock(args.channel);
  try {
    await processEditLocked(args);
  } finally {
    releaseMutation();
  }
}

interface EditRestoreState {
  backendSessionId: string | null;
  useSessionId: string | null;
  restored: boolean;
}

async function initialEditRestoreState(conversation: ChannelConversation): Promise<EditRestoreState> {
  const sessionId = conversation.sessionId;
  const sessionRecord = sessionId ? await sessionStore.getById(sessionId) : null;
  const backendSessionId = sessionRecord ? effectiveBackendSessionId(sessionRecord) : sessionId;
  return { backendSessionId, useSessionId: sessionId, restored: false };
}

/** Cut the transcript back to the plan's anchor; a fresh plan, or a transcript that changed since
 *  planning, drops the backend session so the retry starts a new one. */
async function restoreEditedSession(
  channel: string,
  plan: RestorePlan,
  state: EditRestoreState,
): Promise<EditRestoreState> {
  const restored = plan.kind === 'anchor' && await applyRestore(plan, transcriptCutter);
  if (restored) return { ...state, restored };
  if (plan.kind === 'anchor') log.error('Transcript changed during edit — starting a fresh backend session');
  await deleteSessionAsync(channel);
  return { ...state, restored, useSessionId: null };
}

function stopActiveEdit(channel: string, activeAgents: RunRegistry): void {
  if (!activeAgents.hasChannel(channel)) return;
  activeTurns.markSuperseded(channel, 'edit');
  activeAgents.supersedeByChannel(channel, 'edit');
  conduitQueues.delete(channel);
  log.info('Killed active process for edit retry');
}

interface EditRollback {
  supersededStatusTimestamps: string[];
}

async function rollbackEditedTurn(args: ProcessEditArgs): Promise<EditRollback | null> {
  const result = await conversationLedger.rollbackTo(args.channel, args.turnIndex);
  if (!result) {
    log.error('Rollback failed — no conversation found');
    return null;
  }
  const supersededStatusTimestamps = await cleanupSupersededMessages(
    result.supersededTurns, args.channel, args.adapter,
  );
  return { supersededStatusTimestamps };
}

function registerRestoredEditPath(
  backend: string,
  plan: RestorePlan,
  state: EditRestoreState,
  register: (sessionId: string, sessionPath: string) => void,
): void {
  if (backend !== 'pi' || !state.restored || !state.backendSessionId || plan.kind !== 'anchor') return;
  register(state.backendSessionId, plan.anchor.file);
}

/** Tell the channel the edit was not applied: the backend cannot be put back to that turn. */
async function refuseEdit(args: ProcessEditArgs, sessionId: string | null): Promise<void> {
  log.warn('Edit refused — no restore point for the turn:', { channel: args.channel, turnIndex: args.turnIndex });
  await args.adapter.postMessage(
    { type: 'interactive-reply', conduit: args.channel, sessionId: sessionId ?? '' },
    { text: t('status.editNoRestorePoint') },
  ).catch((e) => log.warn('Failed to post edit refusal:', (e as Error).message));
}

async function processEditLocked(args: ProcessEditArgs): Promise<void> {
  const { channel, originalTs, newText, turnIndex, deps } = args;
  const backend = (deps.resolveBackend ?? resolveBackendForChannel)(channel) || args.conversation.backend;
  const initial = await initialEditRestoreState(args.conversation);
  const plan = await planRestore(
    args.conversation.turns[turnIndex], turnIndex, initial.backendSessionId, transcriptCutter,
  );
  if (!plan) return refuseEdit(args, initial.useSessionId);
  stopActiveEdit(channel, deps.activeAgents);
  const rollback = await rollbackEditedTurn(args);
  if (!rollback) return;
  const state = await restoreEditedSession(channel, plan, initial);
  registerRestoredEditPath(
    backend, plan, state,
    deps.registerPISessionPath ?? ((id, path) => engines.registerSessionPath(id, path)),
  );
  deps.closePooledSession?.(channel, backend);
  await conversationLedger.truncateTurns(channel, turnIndex);
  deps.reprocessMessage(channel, newText, args.adapter, {
    originalTs, sessionId: state.useSessionId,
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
          { text: `${Icons.superseded} ${t('status.supersededByEdit')}` },
        ).catch(() => {})
      );
    }
  }

  await Promise.allSettled(promises);
  return supersededStatusTimestamps;
}

export { createEditHandler };
