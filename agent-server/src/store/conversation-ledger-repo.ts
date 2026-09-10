// input:  conversation-ledger.jsonl through the ledger journal, channel/session ids, Slack ts
// output: ConversationLedgerRepo persistence APIs
// pos:    Channel turn ledger store for session-linked message state
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { AsyncMutex } from '@core/async-mutex.js';
import { STORE_DIR } from '@core/paths.js';
import {
  appendConversationLedgerEvent,
  compactConversationLedger,
  createConversationLedgerState,
  deleteEvent,
  loadConversationLedgerState,
  putEvent,
  shouldCompactConversationLedger,
  type ChannelConversation,
  type ConversationLedgerJournalOptions,
  type ConversationLedgerState,
  type LedgerTurn,
} from './conversation-ledger-journal.js';

export type {
  ChannelConversation,
  LedgerData,
  LedgerTurn,
  TurnStatus,
} from './conversation-ledger-journal.js';

export const LEDGER_FILE = path.join(STORE_DIR, 'conversation-ledger.jsonl');

export type ConversationLedgerRepoOptions = ConversationLedgerJournalOptions;

function nowIso(): string {
  return new Date().toISOString();
}

function newConversation(opts: {
  sessionId: string | null;
  sessionName: string | null;
  backend: string;
  profileName?: string | null;
}): ChannelConversation {
  return {
    sessionId: opts.sessionId,
    sessionName: opts.sessionName,
    backend: opts.backend,
    profileName: opts.profileName ?? null,
    turns: [],
    updatedAt: nowIso(),
  };
}

/** Replace one turn, identified by its user-message ts, leaving the rest of the conversation alone.
 *  Returns null when there is nothing to write — no such turn, or the update declined it. */
function withTurnReplaced(
  conversation: ChannelConversation,
  userMessageTs: string,
  update: (turn: LedgerTurn) => LedgerTurn | null,
): { conversation: ChannelConversation; turn: LedgerTurn } | null {
  const index = conversation.turns.findIndex(turn => turn.userMessageTs === userMessageTs);
  if (index === -1) return null;
  const turn = update(conversation.turns[index]);
  if (!turn) return null;
  const turns = conversation.turns.slice();
  turns[index] = turn;
  return { conversation: { ...conversation, turns }, turn };
}

/**
 * Channel turn ledger, persisted as an append-only JSONL journal (see conversation-ledger-journal).
 *
 * It used to be one JSON object rewritten in full on every mutation: a turn changes ~450 bytes and
 * cost a 1.4MB `JSON.stringify` — 42ms of blocked event loop — three or more times per turn. A
 * mutation now appends the one channel it touched, ~1.2KB at the median.
 *
 * Every mutation appends BEFORE it touches memory, so a failed write leaves the in-memory state
 * exactly as it was rather than one change ahead of the journal.
 */
export class ConversationLedgerRepo {
  private readonly mutex = new AsyncMutex();
  private readonly options: ConversationLedgerRepoOptions;
  private state = createConversationLedgerState();
  private loaded = false;

  constructor(
    private readonly filePath: string = LEDGER_FILE,
    options: ConversationLedgerRepoOptions = {},
  ) {
    this.options = options;
  }

  // --- Read-only queries ---

  async getConversation(channel: string): Promise<ChannelConversation | null> {
    return this.withState(async state => state.channels.get(channel) ?? null);
  }

  async findTurn(channel: string, userMessageTs: string): Promise<{
    conversation: ChannelConversation;
    turn: LedgerTurn;
    turnIndex: number;
  } | null> {
    return this.withState(async (state) => {
      const conversation = state.channels.get(channel);
      if (!conversation) return null;
      const turnIndex = conversation.turns.findIndex(turn => turn.userMessageTs === userMessageTs);
      if (turnIndex === -1) return null;
      return { conversation, turn: conversation.turns[turnIndex], turnIndex };
    });
  }

  async listBySessionIds(sessionIds: Iterable<string>): Promise<Array<ChannelConversation & { channel: string }>> {
    const targets = new Set(sessionIds);
    if (targets.size === 0) return [];
    return this.withState(async (state) => {
      const matches: Array<ChannelConversation & { channel: string }> = [];
      for (const [channel, conversation] of state.channels) {
        if (!conversation.sessionId || !targets.has(conversation.sessionId)) continue;
        matches.push({ ...conversation, channel });
      }
      return matches;
    });
  }

  // --- Mutations ---

  async initConversation(channel: string, opts: {
    sessionId: string | null;
    sessionName: string | null;
    backend: string;
    profileName?: string | null;
  }): Promise<ChannelConversation> {
    return this.withState(async (state) => {
      const conversation = newConversation(opts);
      await this.put(state, channel, conversation);
      return conversation;
    });
  }

  async updateSessionId(channel: string, sessionId: string): Promise<void> {
    await this.withState(async (state) => {
      const conversation = state.channels.get(channel);
      if (!conversation) return;
      await this.put(state, channel, { ...conversation, sessionId, updatedAt: nowIso() });
    });
  }

  async beginTurn(channel: string, opts: {
    userMessageTs: string;
    userMessageText: string;
    statusMessageTs?: string | null;
    backupPath?: string | null;
  }): Promise<LedgerTurn> {
    return this.withState(async (state) => {
      const conversation = state.channels.get(channel);
      if (!conversation) throw new Error(`No conversation for channel ${channel}`);
      const turn = newTurn(conversation.turns.length, {
        ...opts,
        statusMessageTs: opts.statusMessageTs ?? null,
        backupPath: opts.backupPath ?? null,
      });
      await this.put(state, channel, appendTurn(conversation, turn));
      return turn;
    });
  }

  async addResponseTs(channel: string, userMessageTs: string, responseTs: string): Promise<void> {
    await this.withState(async (state) => {
      const conversation = state.channels.get(channel);
      if (!conversation) return;
      // Only the turn's own updatedAt moves: a posted response is not a conversation-level change.
      const next = withTurnReplaced(conversation, userMessageTs, turn => ({
        ...turn,
        responseMessageTimestamps: [...turn.responseMessageTimestamps, responseTs],
        updatedAt: nowIso(),
      }));
      if (next) await this.put(state, channel, next.conversation);
    });
  }

  async completeTurn(channel: string, userMessageTs: string, opts?: {
    executionId?: string | null;
  }): Promise<void> {
    await this.withState(async (state) => {
      const conversation = state.channels.get(channel);
      if (!conversation) return;
      const now = nowIso();
      const next = withTurnReplaced(conversation, userMessageTs, turn => (
        turn.status !== 'processing' ? null : {
          ...turn,
          status: 'completed' as const,
          executionId: opts?.executionId || turn.executionId,
          updatedAt: now,
        }
      ));
      if (next) await this.put(state, channel, { ...next.conversation, updatedAt: now });
    });
  }

  async rollbackTo(channel: string, turnIndex: number): Promise<{
    supersededTurns: LedgerTurn[];
    conversation: ChannelConversation;
  } | null> {
    return this.withState(async (state) => {
      const conversation = state.channels.get(channel);
      if (!conversation) return null;
      if (turnIndex < 0 || turnIndex > conversation.turns.length) return null;
      const now = nowIso();
      const turns = conversation.turns.map((turn, index) => (
        index < turnIndex ? turn : { ...turn, status: 'superseded' as const, updatedAt: now }
      ));
      const next = { ...conversation, turns, updatedAt: now };
      await this.put(state, channel, next);
      return { supersededTurns: turns.slice(turnIndex), conversation: next };
    });
  }

  async truncateTurns(channel: string, fromIndex: number): Promise<void> {
    await this.withState(async (state) => {
      const conversation = state.channels.get(channel);
      if (!conversation) return;
      await this.put(state, channel, {
        ...conversation,
        turns: conversation.turns.slice(0, fromIndex),
        updatedAt: nowIso(),
      });
    });
  }

  async clearConversation(channel: string): Promise<void> {
    await this.withState(async (state) => {
      if (!state.channels.has(channel)) return;
      await appendConversationLedgerEvent(this.filePath, state, deleteEvent(channel), this.options);
      await this.maybeCompact(state);
    });
  }

  async clearBySessionIds(sessionIds: Iterable<string>): Promise<number> {
    const targets = new Set(sessionIds);
    if (targets.size === 0) return 0;
    return this.removeChannels(conversation => (
      !!conversation.sessionId && targets.has(conversation.sessionId)
    ));
  }

  /** Conversations with no sessionId are never dangling — they belong to no session to begin with,
   *  so a live-id sweep must leave them alone. */
  async deleteExceptSessionIds(sessionIds: Iterable<string>): Promise<number> {
    const live = new Set(sessionIds);
    return this.removeChannels(conversation => (
      !!conversation.sessionId && !live.has(conversation.sessionId)
    ));
  }

  async switchSession(channel: string, opts: {
    sessionId: string;
    sessionName: string | null;
    backend: string;
    profileName?: string | null;
  }): Promise<void> {
    await this.withState(async (state) => {
      await this.put(state, channel, newConversation(opts));
    });
  }

  /**
   * Atomic init-if-missing + beginTurn. Captures the turn index under the mutex
   * so callers can safely pass it to sessionBackup.createBackup.
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
    return this.withState(async (state) => {
      const conversation = state.channels.get(channel) ?? newConversation(opts);
      const turnIndex = conversation.turns.length;
      const turn = newTurn(turnIndex, { ...opts, backupPath: null });
      await this.put(state, channel, appendTurn(conversation, turn));
      return { turn, turnIndex };
    });
  }

  /** Set the backup path on the turn identified by userMessageTs. */
  async setBackupPath(channel: string, userMessageTs: string, backupPath: string | null): Promise<void> {
    await this.withState(async (state) => {
      const conversation = state.channels.get(channel);
      if (!conversation) return;
      const next = withTurnReplaced(conversation, userMessageTs, turn => ({
        ...turn, backupPath, updatedAt: nowIso(),
      }));
      if (next) await this.put(state, channel, next.conversation);
    });
  }

  /** Drop the in-memory state so the next read replays from disk. For testing. */
  invalidate(): void {
    this.state = createConversationLedgerState();
    this.loaded = false;
  }

  /** Wait for any in-flight mutation to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this.mutex.run(async () => { });
  }

  // --- Internals ---

  private withState<T>(fn: (state: ConversationLedgerState) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => fn(await this.loadState()));
  }

  private async loadState(): Promise<ConversationLedgerState> {
    if (!this.loaded) {
      this.state = await loadConversationLedgerState(this.filePath, this.options);
      this.loaded = true;
    }
    return this.state;
  }

  private async put(
    state: ConversationLedgerState,
    channel: string,
    conversation: ChannelConversation,
  ): Promise<void> {
    await appendConversationLedgerEvent(this.filePath, state, putEvent(channel, conversation), this.options);
    await this.maybeCompact(state);
  }

  /**
   * Retention sweeps drop hundreds of channels at once. They take the compaction path rather than
   * appending one fsynced delete per channel: the rewrite is a single atomic tmp+rename, and a
   * crash before it simply leaves the sweep to find the same channels next time.
   */
  private async removeChannels(doomed: (conversation: ChannelConversation) => boolean): Promise<number> {
    return this.withState(async (state) => {
      const channels = [...state.channels].filter(([, conversation]) => doomed(conversation));
      if (channels.length === 0) return 0;
      for (const [channel] of channels) state.channels.delete(channel);
      await compactConversationLedger(this.filePath, state, this.options);
      return channels.length;
    });
  }

  private async maybeCompact(state: ConversationLedgerState): Promise<void> {
    if (!shouldCompactConversationLedger(state, this.options)) return;
    await compactConversationLedger(this.filePath, state, this.options);
  }
}

function newTurn(turnIndex: number, opts: {
  userMessageTs: string;
  userMessageText: string;
  statusMessageTs?: string | null;
  backupPath?: string | null;
}): LedgerTurn {
  const now = nowIso();
  return {
    turnIndex,
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
}

function appendTurn(conversation: ChannelConversation, turn: LedgerTurn): ChannelConversation {
  return { ...conversation, turns: [...conversation.turns, turn], updatedAt: turn.createdAt };
}

export const conversationLedger = new ConversationLedgerRepo();
