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
import type { EngineSelection } from '@domain/agents/engine-selection.js';
import type { TurnRecord, TurnStatus } from './session-registry-journal.js';
import type { TurnAnchor } from '@core/types/transcript-anchor.js';

// --- Types ---

export type { TurnStatus };

/** The ledger's turn IS the registry's turn record — one definition, no drift. */
export type LedgerTurn = TurnRecord;

export interface ChannelConversation {
  sessionId: string | null;
  backend: string;
  /** Materialized engine choice retained across resume and hook turns. */
  selection: EngineSelection | null;
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
    backend: header.backend,
    selection: header.selection,
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
    backend: string;
    selection?: EngineSelection | null;
  }): Promise<ChannelConversation> {
    const now = nowIso();
    const header: ConversationHeader = {
      sessionId: opts.sessionId,
      backend: opts.backend,
      selection: opts.selection ?? null,
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

  async switchSession(channel: string, opts: {
    sessionId: string;
    backend: string;
    selection?: EngineSelection | null;
  }): Promise<void> {
    const header: ConversationHeader = {
      sessionId: opts.sessionId,
      backend: opts.backend,
      selection: opts.selection ?? null,
      updatedAt: nowIso(),
    };
    await this.registry.batch(async (ops) => {
      await ops.setConversation(channel, header);
      await ops.clearTurns(channel);
    });
  }

  /**
   * Atomic init-if-missing + beginTurn. Captures the turn index under one lock.
   * Returns { turn, turnIndex } for the caller.
   */
  async initAndBeginTurn(channel: string, opts: {
    sessionId: string | null;
    backend: string;
    selection?: EngineSelection | null;
    userMessageTs: string;
    userMessageText: string;
    statusMessageTs: string;
    anchor?: TurnAnchor | null;
  }): Promise<{ turn: LedgerTurn; turnIndex: number }> {
    return this.registry.batch(async (ops) => {
      if (!ops.getConversationHeader(channel)) {
        await ops.setConversation(channel, {
          sessionId: opts.sessionId,
          backend: opts.backend,
          selection: opts.selection ?? null,
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
        ...(opts.anchor ? { anchor: opts.anchor } : {}),
        status: 'processing',
        createdAt: now,
        updatedAt: now,
      };
      await ops.beginTurn(channel, turn);
      return { turn, turnIndex };
    });
  }

  /** Wait for any in-flight registry mutation to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this.registry.flush();
  }
}

export const conversationLedger = new ConversationLedgerRepo();
