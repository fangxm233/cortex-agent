// input:  session-registry.json + JsonRepository
// output: SessionRegistryRepo identity/context set-clear/list APIs
// pos:    Stable session identity and context snapshot store
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';
import type { SessionContextUsage } from '@core/types/agent-types.js';

// Path of the Slack project→channel registry file. Defined here (rather than
// imported from store/channel-repo.ts) because that file has been removed in
// favour of platform/adapters/slack-project-conduits.ts. We still read the file
// directly for the legacy session-registry name-keyed → sessionId-keyed migration.
const CHANNEL_REGISTRY_FILE = path.join(STORE_DIR, 'channel-registry.json');
import { sessionRepo } from './session-repo.js';
import { executionRepo } from './execution-repo.js';
import { threadStore } from './thread-repo.js';

export const REGISTRY_FILE = path.join(STORE_DIR, 'session-registry.json');

/** How a session was initiated. Orthogonal, finer-grained companion to `kind`:
 *  - 'direct'    — a user-initiated conversation (Slack/Feishu/TUI/Web direct chat)
 *  - 'thread'    — an agent session spawned by a thread step (pipeline / task-dispatch)
 *  - 'scheduled' — a session created by a scheduled job
 *  The UI session list shows only `origin === 'direct'`; thread/scheduled sessions are
 *  surfaced through the Thread and Schedule views. `kind` is retained for resumable
 *  semantics (`kind !== 'scheduled'`); origin never replaces it. */
export type SessionOrigin = 'direct' | 'thread' | 'scheduled';

/** Thread-step sessions are registered with a `[threadId:agentSlotId]` label. Used to
 *  back-fill `origin` for legacy records that predate the field. */
const THREAD_LABEL_RE = /^\[[^\]]+:[^\]]+\]$/;

/** Derive a session's origin from its kind + label. Single source of truth shared by
 *  registerSession (default when a caller omits origin) and the migration back-fill. */
export function deriveSessionOrigin(kind: 'local' | 'scheduled', label: string | null | undefined): SessionOrigin {
  if (kind === 'scheduled') return 'scheduled';
  if (label && THREAD_LABEL_RE.test(label)) return 'thread';
  return 'direct';
}

/** Resolve a record's backend-resume id (Claude `--resume` / PI `--session` target, backup file name)
 *  with legacy fallback. A record that predates the field (`backendSessionId === undefined`) had its
 *  tracking `sessionId` doubling as the backend id, so fall back to it; a fresh record explicitly
 *  carries `null` (backend self-generates on the next turn) and must NOT fall back. */
export function effectiveBackendSessionId(rec: Pick<Session, 'sessionId' | 'backendSessionId'>): string | null {
  return rec.backendSessionId === undefined ? rec.sessionId : rec.backendSessionId;
}

export interface Session {
  name: string;
  /** Stable tracking id — the UI-facing identity, minted by Cortex, never changes. Registry key,
   *  sessions.json channel binding, session.* events, conversation-history and transcript all key on
   *  this. Decoupled from the backend CLI's own session id (see backendSessionId). */
  sessionId: string;
  projectId: string;
  channel: string;
  backend: string;
  kind: 'local' | 'scheduled';
  /** How the session was initiated (direct chat / thread step / scheduled job). */
  origin: SessionOrigin;
  createdAt: string;
  lastUsedAt: string;
  label: string | null;
  /** Profile name active when the session was created. Restored on !resume. */
  profileName: string | null;
  /** Backend CLI's own session id — the resume target (Claude `--resume`, PI `--session`) and the
   *  session-backup jsonl file name. Distinct from the tracking `sessionId`: each backend self-assigns
   *  it (Claude generates a UUID for `--session-id`; PI assigns one at bootstrap), captured from the
   *  turn result and stored here. Semantics:
   *   - `undefined` (legacy record, field absent) → fall back to `sessionId` (old conflated id).
   *   - `null` → not assigned yet (fresh session) → the backend self-generates on the next turn.
   *   - string → the resolved backend id to resume.
   *  Use {@link effectiveBackendSessionId} to read it (handles the legacy fallback). */
  backendSessionId?: string | null;
  /** When the user last VIEWED this session in a client (web workbench sessions.markRead).
   *  Unread = lastUsedAt > lastReadAt. Absent on legacy records → treated as read. */
  lastReadAt?: string | null;
  /** Latest backend-reported context occupancy. Optional for legacy/unsupported sessions. */
  contextUsage?: SessionContextUsage;
}

export type SessionRegistryData = Record<string, Session>;  // keyed by sessionId (UUID)

export class SessionRegistryRepo {
  private readonly _repo: JsonRepository<SessionRegistryData>;
  /** name → sessionId index keeping lookupSession O(1). */
  private _nameIndex = new Map<string, string>();
  /** True once the name index has been fully rebuilt from the complete registry data.
   *  Guards against the index being treated as authoritative when it only holds entries
   *  added incrementally by registerSession() before any full build (which would make
   *  lookupSession() miss every session created in a previous process lifetime). */
  private _indexBuilt = false;
  /** Optional callback invoked when a session is pruned. Receives the sessionId. */
  private _onPruneSession: ((sessionId: string) => void) | null = null;

  constructor(filePath: string = REGISTRY_FILE) {
    this._repo = new JsonRepository<SessionRegistryData>({
      filePath,
      defaultValue: () => ({}),
      migrate: (raw) => {
        if (typeof raw !== 'object' || raw === null) return {};
        const data = raw as Record<string, any>;
        const entries = Object.entries(data);
        if (entries.length === 0) return {};

        // Detect new format: first entry's value has 'name' field
        const firstVal = entries[0][1];
        if (firstVal && typeof firstVal === 'object' && 'name' in firstVal) {
          // Back-fill `origin` for records that predate the field (derive from kind + label).
          for (const rec of Object.values(data)) {
            if (rec && typeof rec === 'object' && !('origin' in rec)) {
              rec.origin = deriveSessionOrigin(rec.kind, rec.label);
            }
          }
          return data as SessionRegistryData;
        }

        // Old format: name-keyed (cortex-XXXX → SessionRecord), values lack 'name' field.
        // Build channel → project reverse map from channel-registry.json.
        const channelToProject: Record<string, string> = {};
        try {
          const channelRegistryRaw = fs.readFileSync(CHANNEL_REGISTRY_FILE, 'utf8');
          const channelRegistry = JSON.parse(channelRegistryRaw) as Record<string, string>;
          // channelRegistry is projectName → channelId; reverse to channelId → projectName.
          for (const [project, channel] of Object.entries(channelRegistry)) {
            channelToProject[channel] = project;
          }
        } catch {
          // channel-registry.json may not exist yet — all projectIds default to 'general'.
        }

        // Re-key from name → sessionId, deduplicate by lastUsedAt.
        const sessionMap = new Map<string, { name: string; record: any }>();
        for (const [name, record] of entries) {
          if (!record || typeof record !== 'object') continue;
          const sid: string = typeof record.sessionId === 'string' ? record.sessionId : '';
          if (!sid) continue;

          const existing = sessionMap.get(sid);
          if (existing && existing.record.lastUsedAt > record.lastUsedAt) continue;
          sessionMap.set(sid, { name, record });
        }

        // Build new format: sessionId-keyed, with name and projectId fields added.
        const result: Record<string, any> = {};
        for (const [sid, { name, record }] of sessionMap) {
          const channel: string = typeof record.channel === 'string' ? record.channel : '';
          result[sid] = {
            ...record,
            name,
            projectId: channelToProject[channel] || 'general',
            origin: record.origin ?? deriveSessionOrigin(record.kind, record.label),
          };
        }
        return result as SessionRegistryData;
      },
    });
  }

  // ── name→sessionId index ──────────────────────────────────────

  private _rebuildNameIndex(data: SessionRegistryData): void {
    this._nameIndex.clear();
    for (const [sid, record] of Object.entries(data)) {
      this._nameIndex.set(record.name, sid);
    }
    this._indexBuilt = true;
  }

  /** Read registry data, performing a one-time full rebuild of the name index.
   *  Must NOT gate on _nameIndex.size: registerSession() populates the index
   *  incrementally, so a non-empty-but-incomplete index would otherwise never be
   *  fully rebuilt and lookups for pre-existing sessions would silently miss. */
  private async _readWithIndex(): Promise<SessionRegistryData> {
    const data = await this._repo.read();
    if (!this._indexBuilt) {
      this._rebuildNameIndex(data);
    }
    return data;
  }

  /** Rebuild the name index from the current cached data (zero I/O on cache hit). */
  private async _syncIndex(): Promise<void> {
    const data = await this._repo.read();
    this._rebuildNameIndex(data);
  }

  // ── Public API ────────────────────────────────────────────────

  async generateSessionName(): Promise<string> {
    const registry = await this._repo.read();
    const knownNames = new Set(Object.values(registry).map((s) => s.name));
    for (let i = 0; i < 100; i++) {
      const hex = crypto.randomBytes(3).toString('hex');
      const name = `cortex-${hex}`;
      if (!knownNames.has(name)) return name;
    }
    return `cortex-${crypto.randomBytes(4).toString('hex')}`;
  }

  async registerSession(name: string, opts: { sessionId: string; channel: string; backend: string; kind: 'local' | 'scheduled'; origin?: SessionOrigin; projectId?: string; label?: string | null; profileName?: string | null; backendSessionId?: string | null }): Promise<void> {
    const now = new Date().toISOString();
    const label = opts.label?.substring(0, 60) || null;
    await this._repo.mutate((registry) => {
      registry[opts.sessionId] = {
        name,
        sessionId: opts.sessionId,
        projectId: opts.projectId ?? 'general',
        channel: opts.channel,
        backend: opts.backend,
        kind: opts.kind,
        origin: opts.origin ?? deriveSessionOrigin(opts.kind, label),
        createdAt: now,
        lastUsedAt: now,
        label,
        profileName: opts.profileName ?? null,
        // Explicit null on a new record = "backend id not yet assigned" (self-generate on the next
        // turn). Distinct from `undefined` on legacy records, which fall back to sessionId.
        backendSessionId: opts.backendSessionId ?? null,
      };
      this._nameIndex.set(name, opts.sessionId);
      return { next: registry, result: undefined };
    });
  }

  async updateSession(name: string, updates: Partial<Pick<Session, 'sessionId' | 'lastUsedAt' | 'label' | 'profileName' | 'backendSessionId' | 'contextUsage'>>): Promise<void> {
    await this._repo.mutate((registry) => {
      // Records are keyed by sessionId; find the target by name.
      for (const record of Object.values(registry)) {
        if (record.name === name) {
          if (updates.sessionId !== undefined) record.sessionId = updates.sessionId;
          if (updates.lastUsedAt !== undefined) record.lastUsedAt = updates.lastUsedAt;
          if (updates.label !== undefined) record.label = updates.label?.substring(0, 60) || null;
          if (updates.profileName !== undefined) record.profileName = updates.profileName;
          if (updates.backendSessionId !== undefined) record.backendSessionId = updates.backendSessionId;
          if (updates.contextUsage !== undefined) record.contextUsage = updates.contextUsage;
          break;
        }
      }
      return { next: registry, result: undefined };
    });
  }

  /** Set or clear a context snapshot by the stable Cortex session id. */
  async updateContextUsage(sessionId: string, usage: SessionContextUsage | null): Promise<void> {
    await this._repo.mutate((registry) => {
      const record = registry[sessionId];
      if (record) {
        if (usage === null) delete record.contextUsage;
        else record.contextUsage = usage;
      }
      return { next: registry, result: undefined };
    });
  }

  async lookupSession(name: string): Promise<Session | null> {
    const registry = await this._readWithIndex();
    let sid = this._nameIndex.get(name);
    if (!sid) {
      // Defensive: if the index somehow drifted from the data (e.g. mutated by a
      // concurrent path), do a full rebuild and retry once before declaring a miss.
      this._rebuildNameIndex(registry);
      sid = this._nameIndex.get(name);
    }
    if (!sid) return null;
    return registry[sid] ?? null;
  }

  async lookupBySessionId(sessionId: string): Promise<string | null> {
    const registry = await this._repo.read();
    const record = registry[sessionId];
    return record?.name ?? null;
  }

  async listRecentSessions(limit = 10): Promise<Session[]> {
    const registry = await this._repo.read();
    return Object.values(registry)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .slice(0, limit);
  }

  /** Return a session by sessionId, or null if not found. O(1) key lookup. */
  async getById(sessionId: string): Promise<Session | null> {
    const registry = await this._repo.read();
    return registry[sessionId] ?? null;
  }

  /** List sessions belonging to a project, most recently used first. */
  async listByProject(projectId: string): Promise<Session[]> {
    const registry = await this._repo.read();
    return Object.values(registry)
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  /** List sessions of a given origin (direct / thread / scheduled), most recent first,
   *  optionally scoped to a project. Drives the UI's origin-filtered session list. */
  async listByOrigin(origin: SessionOrigin, projectId?: string): Promise<Session[]> {
    const registry = await this._repo.read();
    return Object.values(registry)
      .filter((s) => s.origin === origin)
      .filter((s) => projectId === undefined || s.projectId === projectId)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  /** List resumable (non-scheduled) sessions, optionally filtered by projectId. */
  async listResumable(projectId?: string): Promise<Session[]> {
    const registry = await this._repo.read();
    return Object.values(registry)
      .filter((s) => s.kind !== 'scheduled')
      .filter((s) => projectId === undefined || s.projectId === projectId)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  /** Touch the lastUsedAt timestamp of a session to now. No-op if sessionId not found. */
  async markUsed(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    await this._repo.mutate((registry) => {
      const record = registry[sessionId];
      if (record) record.lastUsedAt = now;
      return { next: registry, result: undefined };
    });
  }

  /** Stamp lastReadAt to now — the user viewed this session (unread tracking, web markRead).
   *  No-op if sessionId not found. */
  async markRead(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    await this._repo.mutate((registry) => {
      const record = registry[sessionId];
      if (record) record.lastReadAt = now;
      return { next: registry, result: undefined };
    });
  }

  /**
   * Remove sessions whose lastUsedAt is older than maxAgeMs from now,
   * and are not referenced by any executionRepo or threadStore record.
   * Invokes the onPruneSession callback (if set) for each removed session.
   * Returns the number of removed sessions.
   */
  async pruneStale(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;

    // Build set of sessionIds still referenced by active records.
    const referencedSessionIds = new Set<string>();
    for (const exec of executionRepo.getAll()) {
      if (exec.session.sessionId) referencedSessionIds.add(exec.session.sessionId);
    }
    for (const thread of threadStore.getAll()) {
      for (const agent of Object.values(thread.agents)) {
        if (agent.sessionId) referencedSessionIds.add(agent.sessionId);
      }
      for (const step of thread.steps) {
        if (step.sessionId) referencedSessionIds.add(step.sessionId);
      }
    }

    const count = await this._repo.mutate((registry) => {
      let removed = 0;
      for (const [sid, record] of Object.entries(registry)) {
        const usedAt = new Date(record.lastUsedAt).getTime();
        if (usedAt < cutoff && !referencedSessionIds.has(sid)) {
          this._onPruneSession?.(sid);
          this._nameIndex.delete(record.name);
          delete registry[sid];
          removed++;
        }
      }
      return { next: registry, result: removed };
    });

    return count;
  }

  /** Set a callback to invoke when a session is pruned (e.g. cleanup backup files). */
  setOnPruneSession(fn: ((sessionId: string) => void) | null): void {
    this._onPruneSession = fn;
  }

  async getActiveSessionName(channel: string, backend: string): Promise<string | null> {
    const sessionId = await sessionRepo.getSessionAsync(channel, backend);
    if (!sessionId) return null;
    return this.lookupBySessionId(sessionId);
  }

  /** Drop the in-memory cache so the next read() fetches from disk. Test hook. */
  invalidate(): void {
    this._repo.invalidate();
    this._nameIndex.clear();
    this._indexBuilt = false;
  }

  /** Wait for any in-flight mutate() to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this._repo.flush();
  }
}

export const sessionStore = new SessionRegistryRepo();
/** @deprecated Use `sessionStore` instead. Alias for backward compatibility. */
export const sessionRegistryRepo = sessionStore;
