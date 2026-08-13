// input:  conversation-ledger.json, channel/session ids, Slack ts
// output: ConversationLedgerRepo persistence APIs
// pos:    Channel turn ledger store for session-linked message state
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

const LEDGER_FILE = path.join(STORE_DIR, 'conversation-ledger.json');

// --- Types ---

export type TurnStatus = 'processing' | 'completed' | 'superseded';

export interface LedgerTurn {
  turnIndex: number;
  userMessageTs: string;
  userMessageText: string;
  statusMessageTs: string | null;
  responseMessageTimestamps: string[];
  executionId: string | null;
  backupPath: string | null;
  status: TurnStatus;
  createdAt: string;
  updatedAt: string;
}

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

// --- Repo class ---

export class ConversationLedgerRepo {
  private repo: JsonRepository<LedgerData>;

  constructor(filePath: string = LEDGER_FILE) {
    this.repo = new JsonRepository<LedgerData>({
      filePath,
      defaultValue: () => ({}),
    });
  }

  // --- Read-only queries (no mutex, use repo cache) ---

  async getConversation(channel: string): Promise<ChannelConversation | null> {
    const data = await this.repo.read();
    return data[channel] || null;
  }

  async findTurn(channel: string, userMessageTs: string): Promise<{
    conversation: ChannelConversation;
    turn: LedgerTurn;
    turnIndex: number;
  } | null> {
    const data = await this.repo.read();
    const conv = data[channel];
    if (!conv) return null;
    const idx = conv.turns.findIndex(t => t.userMessageTs === userMessageTs);
    if (idx === -1) return null;
    return { conversation: conv, turn: conv.turns[idx], turnIndex: idx };
  }

  // --- Mutations (mutex-serialized via repo.mutate) ---

  async initConversation(channel: string, opts: {
    sessionId: string | null;
    sessionName: string | null;
    backend: string;
    profileName?: string | null;
  }): Promise<ChannelConversation> {
    return this.repo.mutate(data => {
      const now = nowIso();
      const conv: ChannelConversation = {
        sessionId: opts.sessionId,
        sessionName: opts.sessionName,
        backend: opts.backend,
        profileName: opts.profileName ?? null,
        turns: [],
        updatedAt: now,
      };
      data[channel] = conv;
      return { next: data, result: conv };
    });
  }

  async updateSessionId(channel: string, sessionId: string): Promise<void> {
    await this.repo.mutate(data => {
      const conv = data[channel];
      if (!conv) return { next: data, result: undefined };
      conv.sessionId = sessionId;
      conv.updatedAt = nowIso();
      return { next: data, result: undefined };
    });
  }

  async beginTurn(channel: string, opts: {
    userMessageTs: string;
    userMessageText: string;
    statusMessageTs?: string | null;
    backupPath?: string | null;
  }): Promise<LedgerTurn> {
    return this.repo.mutate(data => {
      const conv = data[channel];
      if (!conv) throw new Error(`No conversation for channel ${channel}`);

      const now = nowIso();
      const turn: LedgerTurn = {
        turnIndex: conv.turns.length,
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
      conv.turns.push(turn);
      conv.updatedAt = now;
      return { next: data, result: turn };
    });
  }

  async addResponseTs(channel: string, userMessageTs: string, responseTs: string): Promise<void> {
    await this.repo.mutate(data => {
      const conv = data[channel];
      if (!conv) return { next: data, result: undefined };
      const turn = conv.turns.find(t => t.userMessageTs === userMessageTs);
      if (!turn) return { next: data, result: undefined };
      turn.responseMessageTimestamps.push(responseTs);
      turn.updatedAt = nowIso();
      return { next: data, result: undefined };
    });
  }

  async completeTurn(channel: string, userMessageTs: string, opts?: {
    executionId?: string | null;
  }): Promise<void> {
    await this.repo.mutate(data => {
      const conv = data[channel];
      if (!conv) return { next: data, result: undefined };
      const turn = conv.turns.find(t => t.userMessageTs === userMessageTs);
      if (!turn || turn.status !== 'processing') return { next: data, result: undefined };
      turn.status = 'completed';
      if (opts?.executionId) turn.executionId = opts.executionId;
      turn.updatedAt = nowIso();
      conv.updatedAt = nowIso();
      return { next: data, result: undefined };
    });
  }

  async rollbackTo(channel: string, turnIndex: number): Promise<{
    supersededTurns: LedgerTurn[];
    conversation: ChannelConversation;
  } | null> {
    return this.repo.mutate(data => {
      const conv = data[channel];
      if (!conv) return { next: data, result: null };
      if (turnIndex < 0 || turnIndex > conv.turns.length) return { next: data, result: null };

      const superseded: LedgerTurn[] = [];
      const now = nowIso();
      for (let i = turnIndex; i < conv.turns.length; i++) {
        conv.turns[i].status = 'superseded';
        conv.turns[i].updatedAt = now;
        superseded.push(conv.turns[i]);
      }
      conv.updatedAt = now;
      return { next: data, result: { supersededTurns: superseded, conversation: conv } };
    });
  }

  async truncateTurns(channel: string, fromIndex: number): Promise<void> {
    await this.repo.mutate(data => {
      const conv = data[channel];
      if (!conv) return { next: data, result: undefined };
      conv.turns = conv.turns.slice(0, fromIndex);
      conv.updatedAt = nowIso();
      return { next: data, result: undefined };
    });
  }

  async clearConversation(channel: string): Promise<void> {
    await this.repo.mutate(data => {
      delete data[channel];
      return { next: data, result: undefined };
    });
  }

  async listBySessionIds(sessionIds: Iterable<string>): Promise<Array<ChannelConversation & { channel: string }>> {
    const targets = new Set(sessionIds);
    if (targets.size === 0) return [];
    const data = await this.repo.read();
    const matches: Array<ChannelConversation & { channel: string }> = [];
    for (const [channel, conversation] of Object.entries(data)) {
      if (!conversation?.sessionId || !targets.has(conversation.sessionId)) continue;
      matches.push({ ...conversation, channel });
    }
    return matches;
  }

  async clearBySessionIds(sessionIds: Iterable<string>): Promise<number> {
    const targets = new Set(sessionIds);
    if (targets.size === 0) return 0;
    return this.repo.mutate(data => {
      let removed = 0;
      for (const [channel, conversation] of Object.entries(data)) {
        if (!conversation?.sessionId || !targets.has(conversation.sessionId)) continue;
        delete data[channel];
        removed += 1;
      }
      return { next: data, result: removed };
    });
  }

  async deleteExceptSessionIds(sessionIds: Iterable<string>): Promise<number> {
    const live = new Set(sessionIds);
    return this.repo.mutate(data => {
      let removed = 0;
      for (const [channel, conversation] of Object.entries(data)) {
        if (!conversation?.sessionId || live.has(conversation.sessionId)) continue;
        delete data[channel];
        removed += 1;
      }
      return { next: data, result: removed };
    });
  }

  async switchSession(channel: string, opts: {
    sessionId: string;
    sessionName: string | null;
    backend: string;
    profileName?: string | null;
  }): Promise<void> {
    await this.repo.mutate(data => {
      const now = nowIso();
      data[channel] = {
        sessionId: opts.sessionId,
        sessionName: opts.sessionName,
        backend: opts.backend,
        profileName: opts.profileName ?? null,
        turns: [],
        updatedAt: now,
      };
      return { next: data, result: undefined };
    });
  }

  /**
   * Atomic init-if-missing + beginTurn. Captures the turn index under mutex
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
    return this.repo.mutate(data => {
      let conv = data[channel];
      if (!conv) {
        conv = {
          sessionId: opts.sessionId,
          sessionName: opts.sessionName,
          backend: opts.backend,
          profileName: opts.profileName ?? null,
          turns: [],
          updatedAt: nowIso(),
        };
        data[channel] = conv;
      }

      const turnIndex = conv.turns.length;
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
      conv.turns.push(turn);
      conv.updatedAt = now;
      return { next: data, result: { turn, turnIndex } };
    });
  }

  /** Set the backup path on the turn identified by userMessageTs. */
  async setBackupPath(channel: string, userMessageTs: string, backupPath: string | null): Promise<void> {
    await this.repo.mutate(data => {
      const conv = data[channel];
      if (!conv) return { next: data, result: undefined };
      const turn = conv.turns.find(t => t.userMessageTs === userMessageTs);
      if (!turn) return { next: data, result: undefined };
      turn.backupPath = backupPath;
      turn.updatedAt = nowIso();
      return { next: data, result: undefined };
    });
  }

  /** Drop the in-memory cache so the next read() fetches from disk. For testing. */
  invalidate(): void {
    this.repo.invalidate();
  }

  /** Wait for any in-flight mutate() to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this.repo.flush();
  }
}

export const conversationLedger = new ConversationLedgerRepo();
