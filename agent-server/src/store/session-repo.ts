// input:  sessions.json + JsonRepository
// output: SessionRepo class and sessionRepo singleton
// pos:    Channel binding store for stable track session ids
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

const SESSIONS_FILE = path.join(STORE_DIR, 'sessions.json');

/**
 * A conduit provider resolves session+project info for non-file-based conduits
 * (e.g., TUI in-memory conduit state). Returns null for unrecognized conduitIds
 * so the file-based lookup is used as fallback.
 */
export type ConduitProvider = (conduitId: string) => { sessionId: string; projectId: string } | null;

/** Registered conduit providers, tried in registration order before file lookup. */
const conduitProviders: ConduitProvider[] = [];

/**
 * Register a conduit provider callback. Called by adapters (e.g., TuiGatewayAdapter)
 * during start() so session lookup can resolve in-memory conduit state.
 */
export function registerConduitProvider(provider: ConduitProvider): void {
  conduitProviders.push(provider);
}

/** Try conduit providers in registration order; returns null if none match. */
async function lookupViaProviders(channel: string): Promise<string | undefined> {
  for (const provider of conduitProviders) {
    const result = provider(channel);
    if (result) return result.sessionId;
  }
  return undefined;
}

/** Shape of sessions.json: `{"<channel>": sessionId, ...}`. Legacy files key on
 *  `"<backend>:<channel>"`; both are read, and `migrateSessionKeys` collapses the old form. */
export type SessionsData = Record<string, string>;

/**
 * D5: a channel has ONE session, and which backend it runs is a property of that session's record,
 * not of the key it is filed under. Keying on `backend:channel` let the same channel hold two
 * bindings at once, so a caller that asked with the wrong backend — cancel, `!session`, the
 * scheduler — silently missed a session that was right there.
 */
const LEGACY_PREFIXES = ['claude', 'pi'] as const;

function legacyKeys(channel: string): string[] {
  return LEGACY_PREFIXES.map(prefix => `${prefix}:${channel}`);
}

/** Split a stored key into the channel it refers to. `web:`/`slack:`/`feishu:`/`tui:` channels
 *  carry their own colons, so only a leading backend name is stripped, and only those two. */
function channelFromKey(key: string): string {
  for (const prefix of LEGACY_PREFIXES) {
    if (key.startsWith(`${prefix}:`)) return key.slice(prefix.length + 1);
  }
  return key;
}

export interface SessionKeyMigrationDeps {
  /** When two backends bound the same channel, the more recently used binding wins. Returns null
   *  for a session the registry has forgotten, which then loses to any dated candidate. */
  lastUsedAt?: (sessionId: string) => Promise<string | null>;
  log?: (message: string) => void;
}

export interface SessionKeyMigrationResult {
  /** Keys rewritten from `backend:channel` to `channel`. */
  migrated: number;
  /** Channels that held two different sessions, one of which was dropped. */
  conflicts: number;
}

export class SessionRepo {
  private _repo: JsonRepository<SessionsData>;

  constructor(filePath: string = SESSIONS_FILE) {
    this._repo = new JsonRepository<SessionsData>({
      filePath,
      defaultValue: () => ({}),
      migrate: (raw) => (typeof raw === 'object' && raw !== null ? (raw as SessionsData) : ({})),
    });
  }

  /**
   * The session bound to a channel.
   *
   * `backend` is accepted and ignored: a channel has one session. The parameter stays so the
   * many call sites that pass one keep compiling while they are cleaned up; it is deprecated.
   *
   * Legacy `backend:channel` keys are still read, so a file written by an older build resolves
   * correctly before `migrateSessionKeys` has run (and in any process that never runs it).
   */
  async getSessionAsync(channel: string, _backend?: string): Promise<string | undefined> {
    // Try conduit providers first (TUI in-memory state, etc.)
    const providerResult = await lookupViaProviders(channel);
    if (providerResult !== undefined) return providerResult;
    // Fall back to file storage
    const sessions = await this._repo.read();
    if (sessions[channel] !== undefined) return sessions[channel];
    for (const key of legacyKeys(channel)) {
      if (sessions[key] !== undefined) return sessions[key];
    }
    return undefined;
  }

  /** Bind a channel to a session. Any legacy backend-prefixed key for the same channel is dropped,
   *  so a write is also a migration of the one channel it touches. */
  async setSessionAsync(channel: string, sessionId: string, _backend?: string): Promise<void> {
    await this._repo.mutate((sessions) => {
      sessions[channel] = sessionId;
      for (const key of legacyKeys(channel)) delete sessions[key];
      return { next: sessions, result: undefined };
    });
  }

  /** Unbind a channel. Deletes every form of the key, so one call really does clear the channel —
   *  where the old signature needed one call per backend and silently left the other behind. */
  async deleteSessionAsync(channel: string, _backend?: string): Promise<void> {
    await this._repo.mutate((sessions) => {
      delete sessions[channel];
      for (const key of legacyKeys(channel)) delete sessions[key];
      return { next: sessions, result: undefined };
    });
  }

  /**
   * Collapse `backend:channel` keys onto `channel`, once, at startup.
   *
   * A channel bound under both backends keeps the more recently used session and drops the other:
   * the two were never usable at the same time — only the channel's current backend was ever
   * consulted — so the newer one is the conversation the user actually has. Every drop is logged
   * with both ids, because that is the only record that the other binding existed.
   */
  async migrateSessionKeys(deps: SessionKeyMigrationDeps = {}): Promise<SessionKeyMigrationResult> {
    const lastUsedAt = deps.lastUsedAt ?? (async () => null);
    const sessions = await this._repo.read();
    const legacy = Object.keys(sessions).filter(key => key !== channelFromKey(key));
    if (legacy.length === 0) return { migrated: 0, conflicts: 0 };

    // Resolve timestamps before the mutate: the mutator must stay synchronous.
    const dated = new Map<string, string | null>();
    for (const key of legacy) {
      const id = sessions[key];
      if (!dated.has(id)) dated.set(id, await lastUsedAt(id).catch(() => null));
    }
    for (const key of legacy) {
      const bare = sessions[channelFromKey(key)];
      if (bare !== undefined && !dated.has(bare)) dated.set(bare, await lastUsedAt(bare).catch(() => null));
    }

    return this._repo.mutate((data) => {
      let migrated = 0;
      let conflicts = 0;
      for (const key of legacy) {
        const value = data[key];
        if (value === undefined) continue;
        delete data[key];
        const channel = channelFromKey(key);
        const incumbent = data[channel];
        if (incumbent === undefined || incumbent === value) {
          data[channel] = value;
          migrated += 1;
          continue;
        }
        conflicts += 1;
        // An undated candidate is one the registry has forgotten; it loses to any dated one, and
        // to the incumbent when neither is dated (first key wins, so the result is deterministic).
        const keep = (dated.get(value) ?? '') > (dated.get(incumbent) ?? '') ? value : incumbent;
        data[channel] = keep;
        deps.log?.(
          `sessions.json: channel ${channel} was bound under two backends `
          + `(${incumbent}, ${value}); keeping the more recently used session ${keep}`,
        );
      }
      return { next: data, result: { migrated, conflicts } };
    });
  }

  async deleteManyBySessionIds(sessionIds: Iterable<string>): Promise<number> {
    const targets = new Set(sessionIds);
    if (targets.size === 0) return 0;
    return this._repo.mutate((sessions) => {
      let removed = 0;
      for (const [key, value] of Object.entries(sessions)) {
        if (!targets.has(value)) continue;
        delete sessions[key];
        removed += 1;
      }
      return { next: sessions, result: removed };
    });
  }

  async deleteExceptSessionIds(sessionIds: Iterable<string>): Promise<number> {
    const live = new Set(sessionIds);
    return this._repo.mutate((sessions) => {
      let removed = 0;
      for (const [key, value] of Object.entries(sessions)) {
        if (live.has(value)) continue;
        delete sessions[key];
        removed += 1;
      }
      return { next: sessions, result: removed };
    });
  }

  /** Drop the in-memory cache so the next read() fetches from disk. Test hook. */
  invalidate(): void {
    this._repo.invalidate();
  }

  /** Wait for any in-flight mutate() to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this._repo.flush();
  }
}

export const sessionRepo = new SessionRepo();
