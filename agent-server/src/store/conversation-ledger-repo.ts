// input:  SessionRegistryRepo (channel bindings + conversation headers + turn history)
// output: ConversationLedgerRepo — a thin FAÇADE over the session registry that keeps the historical
//         ledger API (getConversation / beginTurn / rollbackTo / …) while the registry owns the data.
// pos:    Compatibility surface for turn-history callers; NO storage of its own (no JSON file — the
//         registry journal is the only store)
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
//
// The ledger no longer has a JSON file. Every method maps onto the registry's channel-keyed
// conversation header + turn history, most under a single `registry.batch(...)` critical section so a
// header + turn mutation is atomic (the same guarantee the old JsonRepository.mutate gave). The
// exported names/signatures (ConversationLedgerRepo, conversationLedger, LedgerTurn, TurnStatus,
// ChannelConversation, LedgerData) are unchanged so downstream callers compile untouched.

import {
  sessionStore,
  type ConversationHeader,
  type SessionRegistryRepo,
} from './session-registry-repo.js';
import type { TurnRecord, TurnStatus } from './session-registry-journal.js';

// --- Types ---

export type { TurnStatus };

/** The ledger's turn IS the registry's turn record — one definition, no drift. */
export type LedgerTurn = TurnRecord;

export interface ChannelConversation {
  sessionId: string | null;
  sessionName: string | null;
  backend: string;
  /** Profile name used when the conversation was created or switched — needed
   *  by !new / pre-close hooks to resume the session with the same profile. */
  profileName: string | null;
  turns: LedgerTurn[];
  updatedAt: string;
}

export type LedgerData = Record<string, ChannelConversation>;

function nowIso(): string {
  return new Date().toISOString();
}

/** `updatedAt` is derived, not stored twice: the freshest of the header stamp and any turn stamp.
 *  This preserves the old "bump on every mutation" contract without a second write. */
function deriveUpdatedAt(header: ConversationHeader, turns: LedgerTurn[]): string {
  let latest = header.updatedAt;
  for (const turn of turns) if (turn.updatedAt > latest) latest = turn.updatedAt;
  return latest;
}

function toChannelConversation(header: ConversationHeader, turns: LedgerTurn[]): ChannelConversation {
  return {
    sessionId: header.sessionId,
    sessionName: header.sessionName,
    backend: header.backend,
    profileName: header.profileName,
    turns,
    updatedAt: deriveUpdatedAt(header, turns),
  };
}

// --- Repo class (façade) ---

export class ConversationLedgerRepo {
  constructor(private readonly registry: SessionRegistryRepo = sessionStore) {}

  // --- Read-only queries ---

  async getConversation(channel: string): Promise<ChannelConversation | null> {
    const found = await this.registry.readConversation(channel);
    return found ? toChannelConversation(found.header, found.turns) : null;
  }

  async findTurn(channel: string, userMessageTs: string): Promise<{
    conversation: ChannelConversation;
    turn: LedgerTurn;
    turnIndex: number;
  } | null> {
    const found = await this.registry.readConversation(channel);
    if (!found) return null;
    const idx = found.turns.findIndex(t => t.userMessageTs === userMessageTs);
    if (idx === -1) return null;
    return {
      conversation: toChannelConversation(found.header, found.turns),
      turn: found.turns[idx],
      turnIndex: idx,
    };
  }

  // --- Mutations (registry.batch → one critical section per call) ---

  async initConversation(channel: string, opts: {
    sessionId: string | null;
    sessionName: string | null;
    backend: string;
    profileName?: string | null;
  }): Promise<ChannelConversation> {
    const now = nowIso();
    const header: ConversationHeader = {
      sessionId: opts.sessionId,
      sessionName: opts.sessionName,
      backend: opts.backend,
      profileName: opts.profileName ?? null,
      updatedAt: now,
    };
    await this.registry.batch(async (ops) => {
      await ops.setConversation(channel, header);
      await ops.clearTurns(channel);
    });
    return toChannelConversation(header, []);
  }

  async updateSessionId(channel: string, sessionId: string): Promise<void> {
    await this.registry.batch(async (ops) => {
      if (!ops.getConversationHeader(channel)) return;
      await ops.setConversation(channel, { sessionId, updatedAt: nowIso() });
    });
  }

  async beginTurn(channel: string, opts: {
    userMessageTs: string;
    userMessageText: string;
    statusMessageTs?: string | null;
    backupPath?: string | null;
  }): Promise<LedgerTurn> {
    return this.registry.batch(async (ops) => {
      if (!ops.getConversationHeader(channel)) throw new Error(`No conversation for channel ${channel}`);
      const now = nowIso();
      const turn: LedgerTurn = {
        turnIndex: ops.getTurns(channel).length,
        userMessageTs: opts.userMessageTs,
        userMessageText: opts.userMessageText,
        statusMessageTs: opts.statusMessageTs ?? null,
        responseMessageTimestamps: [],
        executionId: null,
        backupPath: opts.backupPath ?? null,
        status: 'processing',
        createdAt: now,
        updatedAt: now,
      };
      await ops.beginTurn(channel, turn);
      return turn;
    });
  }

  async addResponseTs(channel: string, userMessageTs: string, responseTs: string): Promise<void> {
    await this.registry.batch(async (ops) => {
      const turn = ops.getTurns(channel).find(t => t.userMessageTs === userMessageTs);
      if (!turn) return;
      await ops.patchTurn(channel, turn.turnIndex, {
        responseMessageTimestamps: [...turn.responseMessageTimestamps, responseTs],
        updatedAt: nowIso(),
      });
    });
  }

  async completeTurn(channel: string, userMessageTs: string, opts?: {
    executionId?: string | null;
  }): Promise<void> {
    await this.registry.batch(async (ops) => {
      const turn = ops.getTurns(channel).find(t => t.userMessageTs === userMessageTs);
      if (!turn || turn.status !== 'processing') return;
      await ops.patchTurn(channel, turn.turnIndex, {
        status: 'completed',
        ...(opts?.executionId ? { executionId: opts.executionId } : {}),
        updatedAt: nowIso(),
      });
    });
  }

  async rollbackTo(channel: string, turnIndex: number): Promise<{
    supersededTurns: LedgerTurn[];
    conversation: ChannelConversation;
  } | null> {
    return this.registry.batch(async (ops) => {
      const header = ops.getConversationHeader(channel);
      if (!header) return null;
      const turns = ops.getTurns(channel);
      if (turnIndex < 0 || turnIndex > turns.length) return null;
      const now = nowIso();
      for (let i = turnIndex; i < turns.length; i++) {
        await ops.patchTurn(channel, turns[i].turnIndex, { status: 'superseded', updatedAt: now });
      }
      const updated = ops.getTurns(channel);
      return {
        supersededTurns: updated.slice(turnIndex),
        conversation: toChannelConversation(header, updated),
      };
    });
  }

  async truncateTurns(channel: string, fromIndex: number): Promise<void> {
    await this.registry.truncateTurns(channel, fromIndex);
  }

  async clearConversation(channel: string): Promise<void> {
    await this.registry.batch(async (ops) => {
      await ops.clearConversation(channel);
      await ops.clearTurns(channel);
    });
  }

  async listBySessionIds(sessionIds: Iterable<string>): Promise<Array<ChannelConversation & { channel: string }>> {
    const targets = new Set(sessionIds);
    if (targets.size === 0) return [];
    const all = await this.registry.listConversations();
    const matches: Array<ChannelConversation & { channel: string }> = [];
    for (const { channel, header, turns } of all) {
      if (!header.sessionId || !targets.has(header.sessionId)) continue;
      matches.push({ ...toChannelConversation(header, turns), channel });
    }
    return matches;
  }

  async clearBySessionIds(sessionIds: Iterable<string>): Promise<number> {
    const targets = new Set(sessionIds);
    if (targets.size === 0) return 0;
    const all = await this.registry.listConversations();
    const channels = all
      .filter(({ header }) => header.sessionId && targets.has(header.sessionId))
      .map(({ channel }) => channel);
    if (channels.length === 0) return 0;
    await this.registry.batch(async (ops) => {
      for (const channel of channels) {
        await ops.clearConversation(channel);
        await ops.clearTurns(channel);
      }
    });
    return channels.length;
  }

  async switchSession(channel: string, opts: {
    sessionId: string;
    sessionName: string | null;
    backend: string;
    profileName?: string | null;
  }): Promise<void> {
    const header: ConversationHeader = {
      sessionId: opts.sessionId,
      sessionName: opts.sessionName,
      backend: opts.backend,
      profileName: opts.profileName ?? null,
      updatedAt: nowIso(),
    };
    await this.registry.batch(async (ops) => {
      await ops.setConversation(channel, header);
      await ops.clearTurns(channel);
    });
  }

  /**
   * Atomic init-if-missing + beginTurn. Captures the turn index under one lock
   * so callers can safely pass it to sessionBackup.createBackup.
   * Returns { turn, turnIndex } for the caller.
   */
  async initAndBeginTurn(channel: string, opts: {
    sessionId: string | null;
    sessionName: string | null;
    backend: string;
    profileName?: string | null;
    userMessageTs: string;
    userMessageText: string;
    statusMessageTs: string;
  }): Promise<{ turn: LedgerTurn; turnIndex: number }> {
    return this.registry.batch(async (ops) => {
      if (!ops.getConversationHeader(channel)) {
        await ops.setConversation(channel, {
          sessionId: opts.sessionId,
          sessionName: opts.sessionName,
          backend: opts.backend,
          profileName: opts.profileName ?? null,
          updatedAt: nowIso(),
        });
      }
      const turnIndex = ops.getTurns(channel).length;
      const now = nowIso();
      const turn: LedgerTurn = {
        turnIndex,
        userMessageTs: opts.userMessageTs,
        userMessageText: opts.userMessageText,
        statusMessageTs: opts.statusMessageTs,
        responseMessageTimestamps: [],
        executionId: null,
        backupPath: null,
        status: 'processing',
        createdAt: now,
        updatedAt: now,
      };
      await ops.beginTurn(channel, turn);
      return { turn, turnIndex };
    });
  }

  /** Set the backup path on the turn identified by userMessageTs. */
  async setBackupPath(channel: string, userMessageTs: string, backupPath: string | null): Promise<void> {
    await this.registry.batch(async (ops) => {
      const turn = ops.getTurns(channel).find(t => t.userMessageTs === userMessageTs);
      if (!turn) return;
      await ops.patchTurn(channel, turn.turnIndex, { backupPath, updatedAt: nowIso() });
    });
  }

  /** Drop the registry's in-memory cache so the next read fetches from disk. For testing. */
  invalidate(): void {
    this.registry.invalidate();
  }

  /** Wait for any in-flight registry mutation to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this.registry.flush();
  }
}

export const conversationLedger = new ConversationLedgerRepo();
