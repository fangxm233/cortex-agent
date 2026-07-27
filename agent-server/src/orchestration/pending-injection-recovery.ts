// input:  durable pending records plus ledger/history/store seams
// output: idempotent pending commit and startup orphan recovery
// pos:    cross-store commit coordinator for mid-turn injection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
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
    }): Promise<void>;
  };
  ledger: {
    findTurn(channel: string, messageId: string): Promise<unknown | null>;
    initAndBeginTurn(channel: string, opts: {
      sessionId: string;
      sessionName: string | null;
      backend: string;
      profileName: string | null;
      userMessageTs: string;
      userMessageText: string;
      statusMessageTs: string;
    }): Promise<unknown>;
  };
  now: () => string;
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
  now: () => new Date().toISOString(),
};

async function ensureLedgerTurn(
  record: PendingInjectionRecord,
  deps: PendingInjectionCommitDeps,
): Promise<void> {
  if (await deps.ledger.findTurn(record.channel, record.messageId)) return;
  await deps.ledger.initAndBeginTurn(record.channel, {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    backend: record.backend,
    profileName: record.profileName,
    userMessageTs: record.messageId,
    userMessageText: record.text,
    statusMessageTs: '',
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
): Promise<{ committedTs: string }> {
  const committedTs = deps.now();
  await ensureLedgerTurn(record, deps);
  await ensureHistoryRow(record, committedTs, deps);
  await deps.pendingRepo.remove(record.id);
  return { committedTs };
}

export function commitPendingInjection(
  record: PendingInjectionRecord,
  deps: PendingInjectionCommitDeps = productionPendingInjectionDeps,
): Promise<{ committedTs: string }> {
  return runCommitSerialized(record.channel, () => commitPendingInjectionOnce(record, deps));
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
