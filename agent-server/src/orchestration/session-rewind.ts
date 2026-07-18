// input:  { sessionId, channel, turnIndex, text, adapter } + ledger/backup/history/session singletons
// output: rewindWebSession — channel-agnostic message edit + rewind for web sessions
// pos:    orch/ — the web analogue of routing/edit-handler.ts processEdit: rollback the ledger,
//         restore the backend session backup, close the pooled CLI, truncate the display history,
//         then re-send the edited text as a genuine user turn. Unlike the Slack path there are no
//         platform messages to delete (the web transcript refetches) and the track sessionId /
//         channel binding is ALWAYS kept — a turn-0 edit only clears the backendSessionId so the
//         backend starts a fresh conversation under the same UI identity.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
import type { AttachmentMeta } from '@domain/ui-service/types.js';

const log = createLogger('session-rewind');

export type RewindResult = { ok: true } | { ok: false; reason: 'running' | 'not-found' };

/** Injectable dependency surface (unit tests). Defaults bind the production singletons. */
export interface RewindDeps {
  activeAgents: { hasChannel(channel: string): boolean };
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
  backup: Pick<typeof sessionBackup, 'restoreBackup' | 'cleanupBackupsAfter' | 'cleanupAllBackups' | 'findPISessionFile' | 'restoreSessionFile' | 'cleanupBackupsForFile'>;
  resolveBackend: (channel: string) => string;
  closePooledSession: (channel: string, backend: string) => void;
  send: (opts: { channel: string; text: string; attachments?: AttachmentMeta[]; adapter: PlatformAdapter }) => void;
  publishRewound: (payload: { sessionId: string; channel: string; turnIndex: number }) => void;
}

function defaultDeps(): RewindDeps {
  return {
    activeAgents: runningExecutions,
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
  const { sessionId, channel, turnIndex, text, adapter } = opts;

  // Editing is only allowed while idle (design: 运行中编辑置灰). Server-side guard mirrors the UI.
  if (deps.activeAgents.hasChannel(channel)) return { ok: false, reason: 'running' };

  const conv = await deps.ledger.getConversation(channel);
  if (!conv || turnIndex < 0 || turnIndex >= conv.turns.length) return { ok: false, reason: 'not-found' };

  const rec = await deps.sessionStore.getById(sessionId);
  if (!rec) return { ok: false, reason: 'not-found' };
  const backendSessionId = effectiveBackendSessionId(rec);
  const backend = deps.resolveBackend(channel) || conv.backend;

  log.info('Rewinding session:', { channel, turnIndex, backend });

  // 1. Ledger: mark turns from turnIndex onward superseded.
  await deps.ledger.rollbackTo(channel, turnIndex);

  // 2. Backend session file: restore the pre-turn backup. A turn-0 edit (or a missing backup)
  //    resets the BACKEND conversation only — clear backendSessionId so the next turn starts a
  //    fresh CLI session; the track sessionId and channel binding are untouched (web identity).
  let restored = false;
  if (turnIndex > 0 && backendSessionId) {
    if (backend === 'pi') {
      const piFile = deps.backup.findPISessionFile(backendSessionId);
      restored = piFile ? deps.backup.restoreSessionFile(piFile, turnIndex) : false;
    } else {
      restored = deps.backup.restoreBackup(backendSessionId, turnIndex);
    }
  }
  if (!restored) {
    if (turnIndex > 0) log.warn('No backup found — starting a fresh backend session (display history keeps earlier turns)');
    await deps.sessionStore.updateSession(rec.name, { backendSessionId: null });
    if (backendSessionId) deps.backup.cleanupAllBackups(backendSessionId);
  }

  // 3. Kill any pooled CLI process — an alive stream-json Claude keeps the old conversation in
  //    memory and would ignore the restored jsonl on disk.
  deps.closePooledSession(channel, backend);

  // 4. Ledger + backup cleanup for the superseded range.
  await deps.ledger.truncateTurns(channel, turnIndex);
  if (restored && backendSessionId) {
    if (backend === 'pi') {
      const piFile = deps.backup.findPISessionFile(backendSessionId);
      if (piFile) deps.backup.cleanupBackupsForFile(piFile, turnIndex);
    } else {
      deps.backup.cleanupBackupsAfter(backendSessionId, turnIndex);
    }
  }

  // 5. Display history: drop the edited turn and everything after; remember the original message.
  const removed = await deps.history.truncateFromTurn(sessionId, turnIndex);
  const originalText = removed?.text ?? conv.turns[turnIndex]?.userMessageText ?? '';
  await deps.history.appendEditMarker(sessionId, { originalText, originalTs: removed?.ts ?? '' });

  // 6. Tell live clients the transcript changed shape (they drop their live tails + refetch).
  deps.publishRewound({ sessionId, channel, turnIndex });

  // 7. Re-send the edited text as a genuine user turn (original attachments preserved —
  //    the edit UI cannot add or remove them).
  deps.send({ channel, text, attachments: removed?.attachments, adapter });

  return { ok: true };
}
