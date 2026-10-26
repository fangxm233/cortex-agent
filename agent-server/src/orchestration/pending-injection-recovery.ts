import type { EngineSelection } from '@domain/agents/engine-selection.js';
import { createLogger } from '@core/log.js';
import { sessionSpawnCwd } from '@core/paths.js';
import type { TranscriptPosition, TurnAnchor } from '@core/types/transcript-anchor.js';
import { transcriptFile } from '@domain/sessions/session-transcript.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { effectiveBackendSessionId, sessionStore } from '@store/session-registry-repo.js';
import {
  pendingInjectionRepo,
  type PendingInjectionRecord,
} from '@store/pending-injection-repo.js';

const log = createLogger('pending-injection-recovery');

export interface PendingInjectionCommitDeps {
  pendingRepo: {
    listAll(): Promise<PendingInjectionRecord[]>;
    remove(id: string): Promise<boolean>;
  };
  history: {
    hasUserSourceId(sessionId: string, sourceId: string): Promise<boolean>;
    appendUser(sessionId: string, opts: {
      text: string;
      ts: string;
      attachments?: PendingInjectionRecord['attachments'];
      agentMessage?: string;
      sourceId: string;
      systemOrigin?: PendingInjectionRecord['systemOrigin'];
    }): Promise<void>;
  };
  ledger: {
    findTurn(channel: string, messageId: string): Promise<unknown | null>;
    initAndBeginTurn(channel: string, opts: {
      sessionId: string;
          backend: string;
      selection: EngineSelection | null;
      userMessageTs: string;
      userMessageText: string;
      statusMessageTs: string;
      anchor?: TurnAnchor | null;
    }): Promise<unknown>;
  };
  /** The anchor at `position` in the transcript the record's session currently writes. */
  anchorFor(record: PendingInjectionRecord, position: TranscriptPosition): Promise<TurnAnchor | null>;
  now: () => string;
}

async function currentTranscriptAnchor(
  record: PendingInjectionRecord,
  position: TranscriptPosition,
): Promise<TurnAnchor | null> {
  const session = await sessionStore.getById(record.sessionId);
  const backendSessionId = session ? effectiveBackendSessionId(session) : null;
  if (!backendSessionId) return null;
  const file = await transcriptFile(record.backend, backendSessionId, sessionSpawnCwd(session));
  return file ? { file, ...position } : null;
}

export const productionPendingInjectionDeps: PendingInjectionCommitDeps = {
  pendingRepo: {
    listAll: () => pendingInjectionRepo.listAll(),
    remove: (id) => pendingInjectionRepo.remove(id),
  },
  history: {
    hasUserSourceId: (sessionId, sourceId) => conversationHistory.hasUserSourceId(sessionId, sourceId),
    appendUser: (sessionId, opts) => conversationHistory.appendUser(sessionId, opts),
  },
  ledger: {
    findTurn: (channel, messageId) => conversationLedger.findTurn(channel, messageId),
    initAndBeginTurn: (channel, opts) => conversationLedger.initAndBeginTurn(channel, opts),
  },
  anchorFor: currentTranscriptAnchor,
  now: () => new Date().toISOString(),
};

async function ensureLedgerTurn(
  record: PendingInjectionRecord,
  deps: PendingInjectionCommitDeps,
  position: TranscriptPosition | undefined,
): Promise<void> {
  if (await deps.ledger.findTurn(record.channel, record.messageId)) return;
  const anchor = position ? await deps.anchorFor(record, position) : null;
  await deps.ledger.initAndBeginTurn(record.channel, {
    sessionId: record.sessionId,
    backend: record.backend,
    selection: record.selection,
    userMessageTs: record.messageId,
    userMessageText: record.text,
    statusMessageTs: '',
    anchor,
  });
}

async function ensureHistoryRow(
  record: PendingInjectionRecord,
  committedTs: string,
  deps: PendingInjectionCommitDeps,
): Promise<void> {
  if (await deps.history.hasUserSourceId(record.sessionId, record.id)) return;
  await deps.history.appendUser(record.sessionId, {
    text: record.text,
    ts: committedTs,
    attachments: record.attachments,
    agentMessage: record.agentMessage,
    sourceId: record.id,
    systemOrigin: record.systemOrigin,
  });
}

// Ledger and history are separate serialized stores. Without a coordinator, two acknowledgements
// on one channel can interleave as ledger A → ledger B → history B → history A, permanently making
// their positional rewind indexes disagree. This tiny per-channel chain keeps both stores aligned.
const commitTails = new Map<string, Promise<void>>();

async function runCommitSerialized<T>(channel: string, operation: () => Promise<T>): Promise<T> {
  const previous = commitTails.get(channel) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  commitTails.set(channel, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (commitTails.get(channel) === tail) commitTails.delete(channel);
  }
}

async function commitPendingInjectionOnce(
  record: PendingInjectionRecord,
  deps: PendingInjectionCommitDeps,
  position: TranscriptPosition | undefined,
): Promise<{ committedTs: string }> {
  const committedTs = deps.now();
  await ensureLedgerTurn(record, deps, position);
  await ensureHistoryRow(record, committedTs, deps);
  await deps.pendingRepo.remove(record.id);
  return { committedTs };
}

/** Commit an injected message into history and the ledger. `position` is where the backend wrote
 *  it in its transcript, when the delivery ack said; it becomes the turn's anchor. */
export function commitPendingInjection(
  record: PendingInjectionRecord,
  deps: PendingInjectionCommitDeps = productionPendingInjectionDeps,
  position?: TranscriptPosition,
): Promise<{ committedTs: string }> {
  return runCommitSerialized(record.channel, () => commitPendingInjectionOnce(record, deps, position));
}

export async function recoverPendingInjections(
  deps: PendingInjectionCommitDeps = productionPendingInjectionDeps,
): Promise<number> {
  const records = await deps.pendingRepo.listAll();
  let recovered = 0;
  for (const record of records) {
    try {
      await commitPendingInjection(record, deps);
      recovered++;
    } catch (error) {
      log.error(`Failed to recover pending injection ${record.id}: ${(error as Error).message}`);
    }
  }
  return recovered;
}
