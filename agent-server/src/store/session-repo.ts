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
export type ConduitProvider = (conduitId: string, backend: string) => { sessionId: string; projectId: string } | null;

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
async function lookupViaProviders(channel: string, backend: string): Promise<string | undefined> {
  for (const provider of conduitProviders) {
    const result = provider(channel, backend);
    if (result) return result.sessionId;
  }
  return undefined;
}

/** Shape of sessions.json: `{"backend:channel": sessionId, "legacyChannel": sessionId, ...}` */
export type SessionsData = Record<string, string>;

/** Key format: `backend:channel`. */
function sessionKey(backend: string, channel: string): string {
  return `${backend}:${channel}`;
}

/** Whether a channel name should be treated as "bare" (eligible for legacy-key cleanup). */
function isBareChannel(channel: string): boolean {
  return !channel.includes(':');
}

/** Remove a legacy bare-channel key if the channel qualifies. */
function removeLegacyKey(sessions: SessionsData, channel: string): void {
  if (isBareChannel(channel) && channel in sessions) {
    delete sessions[channel];
  }
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

  async getSessionAsync(channel: string, backend: string): Promise<string | undefined> {
    // Try conduit providers first (TUI in-memory state, etc.)
    const providerResult = await lookupViaProviders(channel, backend);
    if (providerResult !== undefined) return providerResult;
    // Fall back to file storage
    const sessions = await this._repo.read();
    return sessions[sessionKey(backend, channel)] ?? sessions[channel] ?? undefined;
  }

  async setSessionAsync(channel: string, sessionId: string, backend: string): Promise<void> {
    await this._repo.mutate((sessions) => {
      sessions[sessionKey(backend, channel)] = sessionId;
      removeLegacyKey(sessions, channel);
      return { next: sessions, result: undefined };
    });
  }

  async deleteSessionAsync(channel: string, backend: string): Promise<void> {
    await this._repo.mutate((sessions) => {
      delete sessions[sessionKey(backend, channel)];
      removeLegacyKey(sessions, channel);
      return { next: sessions, result: undefined };
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
