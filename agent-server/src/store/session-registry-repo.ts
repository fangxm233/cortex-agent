// input:  session-registry-journal, execution/thread stores, and AsyncMutex
// output: SessionRegistryRepo JSONL-backed registry and admission APIs
// pos:    Stable session identity store with delete-intent guards
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { AsyncMutex } from '@core/async-mutex.js';
import { STORE_DIR } from '@core/paths.js';
import type { SessionContextUsage } from '@core/types/agent-types.js';
import { executionRepo } from './execution-repo.js';
import { sessionRepo } from './session-repo.js';
import {
  appendSessionRegistryEvent,
  compactSessionRegistry,
  createSessionRegistryState,
  deriveSessionOrigin,
  loadSessionRegistryState,
  shouldCompactSessionRegistry,
  type PendingSessionDelete,
  type SessionDeleteCleanup,
  type SessionOrigin,
  type SessionRecord,
  type SessionRegistryJournalOptions,
  type SessionRegistryState,
} from './session-registry-journal.js';
import { threadStore } from './thread-repo.js';

export const REGISTRY_FILE = path.join(STORE_DIR, 'session-registry.jsonl');

export { deriveSessionOrigin, type SessionOrigin };

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
  'lastUsedAt' | 'label' | 'profileName' | 'backendSessionId' | 'contextUsage'
>> & { sessionId?: never };

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

  async registerSession(name: string, opts: {
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
  }): Promise<void> {
    const now = new Date().toISOString();
    return this.appendPut({
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
    await this.withState(async (state) => {
      const sessionId = state.nameIndex.get(name);
      if (!sessionId) return;
      const current = state.live.get(sessionId);
      if (!current) return;
      await this.writePut(state, {
        ...current,
        lastUsedAt: updates.lastUsedAt ?? current.lastUsedAt,
        label: updates.label !== undefined ? trimLabel(updates.label) : current.label,
        profileName: updates.profileName !== undefined ? updates.profileName : current.profileName,
        backendSessionId: updates.backendSessionId !== undefined
          ? updates.backendSessionId
          : current.backendSessionId,
        contextUsage: updates.contextUsage !== undefined ? updates.contextUsage : current.contextUsage,
      } as Session);
    });
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
      await this.writePut(state, { ...current, lastUsedAt: new Date().toISOString() } as Session);
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

  async listPendingDeletions(): Promise<PendingDeletion[]> {
    return this.withState(async (state) => sortPending(state.pending.values()));
  }

  async beginDeleteExpired(
    cutoff: number | Date,
    protectedIds: Iterable<string>,
    prepareCleanup: (session: Session) => Promise<SessionDeleteCleanup> = async () => ({ claudeBackupPaths: [] }),
  ): Promise<PendingDeletion[]> {
    return this.withState(async (state) => {
      const blocked = new Set(protectedIds);
      const removed: PendingDeletion[] = [];
      for (const record of sortRecent(state.live.values())) {
        if (blocked.has(record.sessionId) || this.activeUses.has(record.sessionId)) continue;
        const lastUsedAtMs = parseLastUsedAtMs(record.lastUsedAt);
        if (lastUsedAtMs === null || lastUsedAtMs >= toCutoffMs(cutoff)) continue;
        const cleanup = await prepareCleanup(cloneSession(record));
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

  async getActiveSessionName(channel: string, backend: string): Promise<string | null> {
    const sessionId = await sessionRepo.getSessionAsync(channel, backend);
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

  private async appendPut(record: Session): Promise<void> {
    await this.withState(async (state) => { await this.writePut(state, record); });
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
    return this.withState(async (state) => {
      const current = state.live.get(sessionId);
      if (!current) return null;
      const next = mutate(cloneSession(current));
      await this.writePut(state, next);
      return next;
    });
  }

  private async maybeCompact(state: SessionRegistryState): Promise<void> {
    if (shouldCompactSessionRegistry(state, this.options)) {
      await compactSessionRegistry(this.filePath, state, this.options);
    }
  }
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
