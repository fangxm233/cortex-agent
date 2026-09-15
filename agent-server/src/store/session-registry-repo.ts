// input:  session-registry-journal, execution/thread stores, and AsyncMutex
// output: SessionRegistryRepo JSONL-backed registry and admission APIs
//         (patch-delta updates, channel bindings + conduit resolvers, turn history, batch())
// pos:    Stable session identity store with delete-intent guards
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AsyncMutex } from '@core/async-mutex.js';
import { STORE_DIR } from '@core/paths.js';
import type { SessionContextUsage } from '@core/types/agent-types.js';
import { executionRepo } from './execution-repo.js';
import {
  appendSessionRegistryEvent,
  compactSessionRegistry,
  createSessionRegistryState,
  deriveSessionOrigin,
  loadSessionRegistryState,
  shouldCompactSessionRegistry,
  type ConversationFields,
  type ConversationHeader,
  type PendingSessionDelete,
  type SessionDeleteCleanup,
  type SessionBrowserOption,
  type SessionOrigin,
  type SessionPatchFields,
  type SessionPatchUnsetKey,
  type SessionRecord,
  type SessionRegistryJournalOptions,
  type SessionRegistryState,
  type TurnRecord,
} from './session-registry-journal.js';
import { threadStore } from './thread-repo.js';

export const REGISTRY_FILE = path.join(STORE_DIR, 'session-registry.jsonl');

export {
  deriveSessionOrigin,
  type SessionOrigin,
  type TurnRecord,
  type ConversationFields,
  type ConversationHeader,
};

/** In-memory channel→sessionId resolver (never persisted). A resolver that returns a string wins
 *  over any persisted bind; returning `null`/`undefined` falls through to the next resolver, then to
 *  the persisted bindings index. Registered by conduit-aware platforms (TUI, app.ts). */
export type ConduitResolver = (channel: string) => string | null | undefined;

/** Record keys a `patch` may carry — identity (`name`, `sessionId`) excluded. Used to diff the live
 *  record against the mutated one so a patch line holds ONLY what changed. */
const PATCH_KEYS: SessionPatchUnsetKey[] = [
  'projectId', 'channel', 'backend', 'kind', 'origin', 'createdAt', 'lastUsedAt', 'label',
  'profileName', 'backendSessionId', 'lastReadAt', 'scheduleId', 'commissionId', 'commissionDraft',
  'contextUsage', 'browser',
];

/** Compute the minimal patch from `current` to `next`. A key present in `current` but gone from
 *  `next` (→ `undefined`) is unset; a changed key (incl. an explicit `null`) is set; unchanged keys
 *  are omitted. Returns `null` when nothing changed so the caller appends no event. */
function diffRecord(
  current: SessionRecord,
  next: SessionRecord,
): { fields: SessionPatchFields; unset: SessionPatchUnsetKey[] } | null {
  const fields: Record<string, unknown> = {};
  const unset: SessionPatchUnsetKey[] = [];
  for (const key of PATCH_KEYS) {
    const cur = current[key];
    const nxt = next[key];
    const curHas = cur !== undefined;
    const nxtHas = nxt !== undefined;
    if (!curHas && !nxtHas) continue;
    if (curHas && !nxtHas) { unset.push(key); continue; }
    if (!isDeepStrictEqual(cur, nxt)) fields[key] = nxt;
  }
  if (Object.keys(fields).length === 0 && unset.length === 0) return null;
  return { fields: fields as SessionPatchFields, unset };
}

export interface Session extends Omit<SessionRecord, 'contextUsage'> {
  contextUsage?: SessionContextUsage;
}

export interface PendingDeletion {
  session: Session;
  cleanup: SessionDeleteCleanup;
}

export type SessionRegistryData = Record<string, Session>;
export type SessionRegistryRepoOptions = SessionRegistryJournalOptions;

type UpdateFields = Partial<Pick<Session,
  'lastUsedAt' | 'label' | 'profileName' | 'backendSessionId' | 'contextUsage' | 'browser'
>> & { sessionId?: never };

export interface RegisterSessionOpts {
  sessionId: string;
  channel: string;
  backend: string;
  kind: 'local' | 'scheduled';
  origin?: SessionOrigin;
  projectId?: string;
  label?: string | null;
  profileName?: string | null;
  backendSessionId?: string | null;
  scheduleId?: string | null;
  browser?: SessionBrowserOption | null;
  commissionId?: string | null;
  commissionDraft?: string | null;
}

/** Mutators available inside `batch(fn)` — each shares the one locked state so several events land
 *  in a single critical section (§5). Read APIs are not exposed; read from the returned records. */
export interface SessionRegistryBatch {
  registerSession(name: string, opts: RegisterSessionOpts): Promise<void>;
  updateSession(name: string, updates: UpdateFields): Promise<void>;
  updateById(sessionId: string, mutate: (record: Session) => Session): Promise<Session | null>;
  bindChannel(channel: string, sessionId: string): Promise<void>;
  unbindChannel(channel: string): Promise<void>;
  beginTurn(channel: string, turn: TurnRecord): Promise<void>;
  patchTurn(channel: string, turnIndex: number, fields: Partial<TurnRecord>): Promise<void>;
  truncateTurns(channel: string, fromIndex: number): Promise<void>;
  clearTurns(channel: string): Promise<void>;
  setConversation(channel: string, fields: ConversationFields): Promise<void>;
  clearConversation(channel: string): Promise<void>;
  /** Synchronous reads off the shared locked state — let a façade find-turn / set-if-missing atomically. */
  getTurns(channel: string): TurnRecord[];
  getConversationHeader(channel: string): ConversationHeader | null;
}

function cloneSession(record: SessionRecord): Session {
  return { ...record } as Session;
}

function toStoredRecord(session: Session): SessionRecord {
  return session as SessionRecord;
}

function sortRecent(records: Iterable<SessionRecord>): Session[] {
  return Array.from(records, cloneSession)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

function sortPending(entries: Iterable<PendingSessionDelete>): PendingDeletion[] {
  return Array.from(entries, entry => ({
    session: cloneSession(entry.session),
    cleanup: { claudeBackupPaths: [...entry.cleanup.claudeBackupPaths] },
  })).sort((a, b) => b.session.lastUsedAt.localeCompare(a.session.lastUsedAt));
}

function trimLabel(label: string | null | undefined): string | null {
  return label?.substring(0, 60) || null;
}

function toCutoffMs(cutoff: number | Date): number {
  return cutoff instanceof Date ? cutoff.getTime() : cutoff;
}

function parseLastUsedAtMs(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function setContextUsage(record: Session, usage: SessionContextUsage | null): Session {
  if (usage === null) {
    delete record.contextUsage;
    return record;
  }
  record.contextUsage = usage;
  return record;
}

export function effectiveBackendSessionId(rec: Pick<Session, 'sessionId' | 'backendSessionId'>): string | null {
  return rec.backendSessionId === undefined ? rec.sessionId : rec.backendSessionId;
}

export class SessionRegistryRepo {
  private readonly mutex = new AsyncMutex();
  private readonly options: SessionRegistryRepoOptions;
  private state = createSessionRegistryState();
  private loaded = false;
  private activeUses = new Map<string, number>();
  private conduitResolvers: ConduitResolver[] = [];

  constructor(private readonly filePath: string = REGISTRY_FILE, options: SessionRegistryRepoOptions = {}) {
    this.options = options;
  }

  async generateSessionName(): Promise<string> {
    return this.withState(async (state) => {
      const blocked = new Set([...state.nameIndex.keys(), ...Array.from(state.pending.values(), entry => entry.session.name)]);
      for (let i = 0; i < 100; i += 1) {
        const name = `cortex-${crypto.randomBytes(3).toString('hex')}`;
        if (!blocked.has(name)) return name;
      }
      return `cortex-${crypto.randomBytes(4).toString('hex')}`;
    });
  }

  async registerSession(name: string, opts: RegisterSessionOpts): Promise<void> {
    await this.withState((state) => this.doRegisterSession(state, name, opts));
  }

  private async doRegisterSession(state: SessionRegistryState, name: string, opts: RegisterSessionOpts): Promise<void> {
    const now = new Date().toISOString();
    await this.writePut(state, {
      name,
      sessionId: opts.sessionId,
      projectId: opts.projectId ?? 'general',
      channel: opts.channel,
      backend: opts.backend,
      kind: opts.kind,
      origin: opts.origin ?? deriveSessionOrigin(opts.kind, opts.label ?? null),
      createdAt: now,
      lastUsedAt: now,
      label: trimLabel(opts.label),
      profileName: opts.profileName ?? null,
      backendSessionId: opts.backendSessionId ?? null,
      scheduleId: opts.scheduleId ?? null,
      browser: opts.browser ?? null,
      commissionId: opts.commissionId ?? null,
      commissionDraft: opts.commissionDraft ?? null,
    });
  }

  async convertToDirect(sessionId: string, opts: { channel: string }): Promise<Session | null> {
    return this.updateById(sessionId, (record) => ({
      ...record,
      channel: opts.channel,
      kind: 'local',
      origin: 'direct',
    }));
  }

  async updateSession(name: string, updates: UpdateFields): Promise<void> {
    if ('sessionId' in updates) throw new Error('updateSession may not change sessionId');
    await this.withState((state) => this.doUpdateSession(state, name, updates));
  }

  private async doUpdateSession(state: SessionRegistryState, name: string, updates: UpdateFields): Promise<void> {
    const sessionId = state.nameIndex.get(name);
    if (!sessionId) return;
    const current = state.live.get(sessionId);
    if (!current) return;
    await this.writePatch(state, current, {
      ...current,
      lastUsedAt: updates.lastUsedAt ?? current.lastUsedAt,
      label: updates.label !== undefined ? trimLabel(updates.label) : current.label,
      profileName: updates.profileName !== undefined ? updates.profileName : current.profileName,
      backendSessionId: updates.backendSessionId !== undefined
        ? updates.backendSessionId
        : current.backendSessionId,
      browser: updates.browser !== undefined ? updates.browser : current.browser,
      contextUsage: updates.contextUsage !== undefined ? updates.contextUsage : current.contextUsage,
    } as SessionRecord);
  }

  async updateContextUsage(sessionId: string, usage: SessionContextUsage | null): Promise<void> {
    await this.updateById(sessionId, (record) => setContextUsage({ ...record } as Session, usage));
  }

  async lookupSession(name: string): Promise<Session | null> {
    return this.withState(async (state) => {
      const sessionId = state.nameIndex.get(name);
      const record = sessionId ? state.live.get(sessionId) : null;
      return record ? cloneSession(record) : null;
    });
  }

  async lookupBySessionId(sessionId: string): Promise<string | null> {
    return this.withState(async (state) => state.live.get(sessionId)?.name ?? null);
  }

  async listRecentSessions(limit = 10): Promise<Session[]> {
    return this.withState(async (state) => sortRecent(state.live.values()).slice(0, limit));
  }

  async getById(sessionId: string): Promise<Session | null> {
    return this.withState(async (state) => {
      const record = state.live.get(sessionId);
      return record ? cloneSession(record) : null;
    });
  }

  async listByProject(projectId: string): Promise<Session[]> {
    return this.withState(async (state) => sortRecent(filterLive(state, s => s.projectId === projectId)));
  }

  async listByOrigin(origin: SessionOrigin, projectId?: string): Promise<Session[]> {
    return this.withState(async (state) => sortRecent(
      filterLive(state, s => s.origin === origin && (projectId === undefined || s.projectId === projectId)),
    ));
  }

  async listResumable(projectId?: string): Promise<Session[]> {
    return this.withState(async (state) => sortRecent(
      filterLive(state, s => s.kind !== 'scheduled' && (projectId === undefined || s.projectId === projectId)),
    ));
  }

  async touchForUse(sessionId: string): Promise<boolean> {
    const release = await this.acquireSessionUse(sessionId);
    if (!release) return false;
    release();
    return true;
  }

  async acquireSessionUse(sessionId: string): Promise<(() => void) | null> {
    return this.withState(async (state) => {
      const current = state.live.get(sessionId);
      if (!current || state.pending.has(sessionId)) return null;
      await this.writePatch(state, current, { ...current, lastUsedAt: new Date().toISOString() });
      this.activeUses.set(sessionId, (this.activeUses.get(sessionId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (this.activeUses.get(sessionId) ?? 1) - 1;
        if (next <= 0) this.activeUses.delete(sessionId);
        else this.activeUses.set(sessionId, next);
      };
    });
  }

  async withSessionUse<T>(sessionId: string, fn: () => Promise<T>): Promise<T | null> {
    const release = await this.acquireSessionUse(sessionId);
    if (!release) return null;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async markUsed(sessionId: string): Promise<void> {
    await this.touchForUse(sessionId);
  }

  async markRead(sessionId: string): Promise<void> {
    await this.updateById(sessionId, (record) => ({
      ...record,
      lastReadAt: new Date().toISOString(),
    }));
  }

  /** Bind (or unbind with null) a session to a commission. Called by the commission finalize path
   *  (DR-0037) and by commission-mode session creation. Binding also clears commissionDraft: once
   *  the contract is named, the draft directory no longer exists under that name.
   *
   *  `commissionBlockFor` is deliberately left alone: binding CHANGES the key (`draft:x` →
   *  `active:id`), and that mismatch is exactly what makes the next turn deliver the active block. */
  async bindCommission(sessionId: string, commissionId: string | null): Promise<Session | null> {
    return this.updateById(sessionId, (record) => ({
      ...record,
      commissionId,
      commissionDraft: commissionId ? null : record.commissionDraft,
    }));
  }

  /** Enter (or leave, with null) the drafting half of commission mode. Called by
   *  `cortex_commission_start`, by the composer's "new" on a live session, and by session creation.
   *  Refuses to touch a session already bound to a commission — that is a terminal state. */
  async setCommissionDraft(sessionId: string, draftDir: string | null): Promise<Session | null> {
    return this.updateById(sessionId, (record) => (
      record.commissionId
        ? record
        : { ...record, commissionDraft: draftDir }
    ));
  }

  /** Record that the `[Commission]` block for `key` is now in this session's backend history. */
  async markCommissionBlockDelivered(sessionId: string, key: string): Promise<Session | null> {
    return this.updateById(sessionId, (record) => ({ ...record, commissionBlockFor: key }));
  }

  /** Forget the delivery marker so the next turn re-injects the block. Called after compaction,
   *  which drops the copy that was in backend history. */
  async clearCommissionBlockDelivery(sessionId: string): Promise<Session | null> {
    return this.updateById(sessionId, (record) => ({ ...record, commissionBlockFor: null }));
  }

  // --- Channel bindings (channel → conversation sessionId) ------------------------------------

  /** Register an in-memory conduit resolver. Never persisted; a resolver answer wins over a
   *  persisted bind (§6). Returns an unregister callback. */
  registerConduitResolver(fn: ConduitResolver): () => void {
    this.conduitResolvers.push(fn);
    return () => {
      const idx = this.conduitResolvers.indexOf(fn);
      if (idx >= 0) this.conduitResolvers.splice(idx, 1);
    };
  }

  /** Resolve the conversation session for a channel: in-memory resolvers first (a string wins),
   *  then the persisted bindings index. */
  async getBoundSessionId(channel: string): Promise<string | null> {
    for (const resolve of this.conduitResolvers) {
      const answer = resolve(channel);
      if (typeof answer === 'string' && answer) return answer;
    }
    return this.withState(async (state) => state.bindings.get(channel) ?? null);
  }

  async bindChannel(channel: string, sessionId: string): Promise<void> {
    await this.withState((state) => this.doBindChannel(state, channel, sessionId));
  }

  async unbindChannel(channel: string): Promise<void> {
    await this.withState((state) => this.doUnbindChannel(state, channel));
  }

  /** Remove every binding pointing at one of `sessionIds`. Used when sessions are torn down.
   *  Returns the number of bindings removed. */
  async unbindBySessionIds(sessionIds: Iterable<string>): Promise<number> {
    const targets = new Set(sessionIds);
    return this.withState(async (state) => {
      const channels = Array.from(state.bindings)
        .filter(([, boundId]) => targets.has(boundId))
        .map(([channel]) => channel);
      for (const channel of channels) await this.doUnbindChannel(state, channel);
      return channels.length;
    });
  }

  async listBindings(): Promise<Array<{ channel: string; sessionId: string }>> {
    return this.withState(async (state) =>
      Array.from(state.bindings, ([channel, sessionId]) => ({ channel, sessionId })));
  }

  // --- Turn history (channel → ordered turns) -------------------------------------------------

  async beginTurn(channel: string, turn: TurnRecord): Promise<void> {
    await this.withState((state) => this.doBeginTurn(state, channel, turn));
  }

  async patchTurn(channel: string, turnIndex: number, fields: Partial<TurnRecord>): Promise<void> {
    await this.withState((state) => this.doPatchTurn(state, channel, turnIndex, fields));
  }

  async truncateTurns(channel: string, fromIndex: number): Promise<void> {
    await this.withState((state) => this.doTruncateTurns(state, channel, fromIndex));
  }

  async clearTurns(channel: string): Promise<void> {
    await this.withState((state) => this.doClearTurns(state, channel));
  }

  async getTurns(channel: string): Promise<TurnRecord[]> {
    return this.withState(async (state) => readTurns(state, channel));
  }

  async findTurn(channel: string, pred: (turn: TurnRecord) => boolean): Promise<TurnRecord | null> {
    return this.withState(async (state) => {
      const found = (state.turns.get(channel) ?? []).find(pred);
      return found ? { ...found } : null;
    });
  }

  // --- Conversation headers (channel → session identity of the hosted conversation) -----------

  async getConversationHeader(channel: string): Promise<ConversationHeader | null> {
    return this.withState(async (state) => readConversationHeader(state, channel));
  }

  async setConversation(channel: string, fields: ConversationFields): Promise<void> {
    await this.withState((state) => this.doSetConversation(state, channel, fields));
  }

  async clearConversation(channel: string): Promise<void> {
    await this.withState((state) => this.doClearConversation(state, channel));
  }

  /** Header + turns for a channel under ONE lock (or null when the channel has no header). */
  async readConversation(channel: string): Promise<{ header: ConversationHeader; turns: TurnRecord[] } | null> {
    return this.withState(async (state) => {
      const header = readConversationHeader(state, channel);
      if (!header) return null;
      return { header, turns: readTurns(state, channel) };
    });
  }

  /** Every channel that has a conversation header, with its turns — one lock for the whole scan. */
  async listConversations(): Promise<Array<{ channel: string; header: ConversationHeader; turns: TurnRecord[] }>> {
    return this.withState(async (state) =>
      Array.from(state.conversations, ([channel, header]) => ({
        channel,
        header: { ...header },
        turns: readTurns(state, channel),
      })));
  }

  /** Run several mutations under ONE admission lock (T2/T3 need put+bind+turn atomically — never a
   *  put without its bind, §5). The ops mirror the top-level mutators but share the locked state. */
  async batch<T>(fn: (ops: SessionRegistryBatch) => Promise<T>): Promise<T> {
    return this.withState((state) => fn(this.batchOps(state)));
  }

  private batchOps(state: SessionRegistryState): SessionRegistryBatch {
    return {
      registerSession: (name, opts) => this.doRegisterSession(state, name, opts),
      updateSession: (name, updates) => {
        if ('sessionId' in updates) throw new Error('updateSession may not change sessionId');
        return this.doUpdateSession(state, name, updates);
      },
      updateById: (sessionId, mutate) => this.doUpdateById(state, sessionId, mutate),
      bindChannel: (channel, sessionId) => this.doBindChannel(state, channel, sessionId),
      unbindChannel: (channel) => this.doUnbindChannel(state, channel),
      beginTurn: (channel, turn) => this.doBeginTurn(state, channel, turn),
      patchTurn: (channel, turnIndex, fields) => this.doPatchTurn(state, channel, turnIndex, fields),
      truncateTurns: (channel, fromIndex) => this.doTruncateTurns(state, channel, fromIndex),
      clearTurns: (channel) => this.doClearTurns(state, channel),
      setConversation: (channel, fields) => this.doSetConversation(state, channel, fields),
      clearConversation: (channel) => this.doClearConversation(state, channel),
      getTurns: (channel) => readTurns(state, channel),
      getConversationHeader: (channel) => readConversationHeader(state, channel),
    };
  }

  private async doBindChannel(state: SessionRegistryState, channel: string, sessionId: string): Promise<void> {
    if (state.bindings.get(channel) === sessionId) return;
    await appendSessionRegistryEvent(this.filePath, state, { v: 1, op: 'bind', channel, sessionId }, this.options);
    await this.maybeCompact(state);
  }

  private async doUnbindChannel(state: SessionRegistryState, channel: string): Promise<void> {
    if (!state.bindings.has(channel)) return;
    await appendSessionRegistryEvent(this.filePath, state, { v: 1, op: 'unbind', channel }, this.options);
    await this.maybeCompact(state);
  }

  private async doBeginTurn(state: SessionRegistryState, channel: string, turn: TurnRecord): Promise<void> {
    await appendSessionRegistryEvent(this.filePath, state,
      { v: 1, op: 'turn', channel, kind: 'begin', turn: { ...turn } }, this.options);
    await this.maybeCompact(state);
  }

  private async doPatchTurn(
    state: SessionRegistryState,
    channel: string,
    turnIndex: number,
    fields: Partial<TurnRecord>,
  ): Promise<void> {
    await appendSessionRegistryEvent(this.filePath, state,
      { v: 1, op: 'turn', channel, kind: 'patch', turnIndex, fields: { ...fields } }, this.options);
    await this.maybeCompact(state);
  }

  private async doTruncateTurns(state: SessionRegistryState, channel: string, fromIndex: number): Promise<void> {
    await appendSessionRegistryEvent(this.filePath, state,
      { v: 1, op: 'turn', channel, kind: 'truncate', fromIndex }, this.options);
    await this.maybeCompact(state);
  }

  private async doClearTurns(state: SessionRegistryState, channel: string): Promise<void> {
    await appendSessionRegistryEvent(this.filePath, state,
      { v: 1, op: 'turn', channel, kind: 'clear' }, this.options);
    await this.maybeCompact(state);
  }

  private async doSetConversation(
    state: SessionRegistryState,
    channel: string,
    fields: ConversationFields,
  ): Promise<void> {
    await appendSessionRegistryEvent(this.filePath, state,
      { v: 1, op: 'conversation', channel, kind: 'set', fields: { ...fields } }, this.options);
    await this.maybeCompact(state);
  }

  private async doClearConversation(state: SessionRegistryState, channel: string): Promise<void> {
    if (!state.conversations.has(channel)) return;
    await appendSessionRegistryEvent(this.filePath, state,
      { v: 1, op: 'conversation', channel, kind: 'clear' }, this.options);
    await this.maybeCompact(state);
  }

  async listPendingDeletions(): Promise<PendingDeletion[]> {
    return this.withState(async (state) => sortPending(state.pending.values()));
  }

  async beginDeleteExpired(
    cutoff: number | Date,
    protectedIds: Iterable<string>,
    prepareCleanup: (session: Session, turns: TurnRecord[]) => Promise<SessionDeleteCleanup>
      = async () => ({ claudeBackupPaths: [] }),
  ): Promise<PendingDeletion[]> {
    return this.withState(async (state) => {
      const blocked = new Set(protectedIds);
      const removed: PendingDeletion[] = [];
      for (const record of sortRecent(state.live.values())) {
        if (blocked.has(record.sessionId) || this.activeUses.has(record.sessionId)) continue;
        const lastUsedAtMs = parseLastUsedAtMs(record.lastUsedAt);
        if (lastUsedAtMs === null || lastUsedAtMs >= toCutoffMs(cutoff)) continue;
        // Hand the callback the session's turns from the locked state directly — the ledger is now a
        // façade over THIS registry, so a callback that read it back would re-enter `withState` and
        // deadlock. (The old ledger was a separate store with its own lock.)
        const cleanup = await prepareCleanup(cloneSession(record), collectSessionTurns(state, record.sessionId));
        await appendSessionRegistryEvent(this.filePath, state, {
          v: 1,
          op: 'delete-intent',
          id: record.sessionId,
          record: toStoredRecord(cloneSession(record)),
          cleanup,
        }, this.options);
        await this.maybeCompact(state);
        removed.push({ session: cloneSession(record), cleanup });
      }
      return removed;
    });
  }

  async commitDeletion(sessionId: string): Promise<boolean> {
    return this.withState(async (state) => {
      if (!state.pending.has(sessionId)) return false;
      await appendSessionRegistryEvent(this.filePath, state, { v: 1, op: 'delete-commit', id: sessionId }, this.options);
      await this.maybeCompact(state);
      return true;
    });
  }

  async pruneStale(maxAgeMs: number): Promise<number> {
    const protectedIds = referencedSessionIds();
    const pending = await this.beginDeleteExpired(Date.now() - maxAgeMs, protectedIds);
    for (const entry of pending) await this.commitDeletion(entry.session.sessionId);
    return pending.length;
  }

  setOnPruneSession(_fn: ((sessionId: string) => void) | null): void {
    // Deprecated compatibility shim. Journal pruning no longer performs filesystem callbacks.
  }

  async compactNow(): Promise<void> {
    await this.withState(async (state) => {
      await compactSessionRegistry(this.filePath, state, this.options);
    });
  }

  /** `backend` is accepted and ignored — a channel has one session. Pure in-registry lookup:
   *  the channel's bound sessionId → the live record's name. */
  async getActiveSessionName(channel: string, backend?: string): Promise<string | null> {
    const sessionId = await this.getBoundSessionId(channel);
    if (!sessionId) return null;
    return this.lookupBySessionId(sessionId);
  }

  invalidate(): void {
    this.state = createSessionRegistryState();
    this.loaded = false;
  }

  flush(): Promise<void> {
    return this.mutex.run(async () => {});
  }

  private withState<T>(fn: (state: SessionRegistryState) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => fn(await this.loadState()));
  }

  private async loadState(): Promise<SessionRegistryState> {
    if (!this.loaded) {
      this.state = await loadSessionRegistryState(this.filePath, this.options);
      this.loaded = true;
    }
    return this.state;
  }

  private async writePut(state: SessionRegistryState, record: Session): Promise<void> {
    await appendSessionRegistryEvent(this.filePath, state, {
      v: 1,
      op: 'put',
      id: record.sessionId,
      record: toStoredRecord(record),
    }, this.options);
    await this.maybeCompact(state);
  }

  private async updateById(
    sessionId: string,
    mutate: (record: Session) => Session,
  ): Promise<Session | null> {
    return this.withState((state) => this.doUpdateById(state, sessionId, mutate));
  }

  private async doUpdateById(
    state: SessionRegistryState,
    sessionId: string,
    mutate: (record: Session) => Session,
  ): Promise<Session | null> {
    const current = state.live.get(sessionId);
    if (!current) return null;
    const next = mutate(cloneSession(current));
    await this.writePatch(state, current, next as SessionRecord);
    return next;
  }

  /** Append a `patch` for the delta between `current` (live) and `next`. No-op when nothing changed. */
  private async writePatch(state: SessionRegistryState, current: SessionRecord, next: SessionRecord): Promise<void> {
    const delta = diffRecord(current, next);
    if (!delta) return;
    await appendSessionRegistryEvent(this.filePath, state, {
      v: 1,
      op: 'patch',
      id: current.sessionId,
      name: current.name,
      fields: delta.fields,
      ...(delta.unset.length ? { unset: delta.unset } : {}),
    }, this.options);
    await this.maybeCompact(state);
  }

  private async maybeCompact(state: SessionRegistryState): Promise<void> {
    if (shouldCompactSessionRegistry(state, this.options)) {
      await compactSessionRegistry(this.filePath, state, this.options);
    }
  }
}

function readTurns(state: SessionRegistryState, channel: string): TurnRecord[] {
  return (state.turns.get(channel) ?? []).map(turn => ({ ...turn }));
}

function readConversationHeader(state: SessionRegistryState, channel: string): ConversationHeader | null {
  const header = state.conversations.get(channel);
  return header ? { ...header } : null;
}

/** Turns of every channel whose conversation header names `sessionId` — the same rows the ledger's
 *  `listBySessionIds` would surface, read straight from the (already-locked) state. */
function collectSessionTurns(state: SessionRegistryState, sessionId: string): TurnRecord[] {
  const turns: TurnRecord[] = [];
  for (const [channel, header] of state.conversations) {
    if (header.sessionId === sessionId) turns.push(...readTurns(state, channel));
  }
  return turns;
}

function* filterLive(
  state: SessionRegistryState,
  predicate: (session: SessionRecord) => boolean,
): Iterable<SessionRecord> {
  for (const record of state.live.values()) {
    if (predicate(record)) yield record;
  }
}

function referencedSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const exec of executionRepo.getAll()) {
    if (exec.session.sessionId) ids.add(exec.session.sessionId);
  }
  for (const thread of threadStore.getAll()) {
    for (const agent of Object.values(thread.agents)) {
      if (agent.sessionId) ids.add(agent.sessionId);
    }
    for (const step of thread.steps) {
      if (step.sessionId) ids.add(step.sessionId);
    }
  }
  return ids;
}

export const sessionStore = new SessionRegistryRepo();
export const sessionRegistryRepo = sessionStore;
