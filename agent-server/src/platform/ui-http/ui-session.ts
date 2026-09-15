// input:  a TTL + a persistence file path (both optional), and session ids presented by clients
// output: createUiSessionStore(...) -> { create, verify, revoke, size } and parseCookie(header, name)
// pos:    Browser session leg of the Web UI auth gate (platform/ui-http). A browser that proves it
//         holds the clientToken once (POST /api/ui/login) is handed an opaque session id in an
//         HttpOnly cookie; every later request is admitted by that id instead of the token, so the
//         secret itself never enters the page's JavaScript. Ids are 32 random bytes with an
//         ABSOLUTE expiry (verify never renews — that keeps verify write-free), persisted to
//         DATA_DIR/ui-sessions.json at 0600 so a daemon restart does not log every browser out.
//         A session id is bearer-equivalent but strictly weaker than the token: the auth gate never
//         accepts it on the /forward WebSocket upgrade (see ui-http-server.ts).

import * as crypto from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import * as path from 'path';
import { timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';

const log = createLogger('ui-http');

/** 30 days. Long enough that a browser is not re-prompted in normal use, short enough to expire. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface UiSessionStore {
  /** Mint a new session id, persist it, and return it. */
  create(): string;
  /** True iff the id matches a live (unexpired) session. Constant-time; never renews. */
  verify(sid: string | undefined): boolean;
  /** Drop a session (logout). Unknown ids are a no-op. */
  revoke(sid: string | undefined): void;
  /** Live (unexpired) session count — for tests and logging. */
  size(): number;
}

export interface UiSessionStoreOptions {
  /** Absolute session lifetime in ms. Defaults to 30 days. */
  ttlMs?: number;
  /** Persistence file. When omitted the store is memory-only (used by tests). */
  file?: string;
  /** Clock injection for tests. */
  now?: () => number;
}

/** On-disk shape: id → epoch-ms expiry. A flat map keeps the file trivially forward-compatible. */
type Persisted = Record<string, number>;

/**
 * Read one cookie value out of a raw `Cookie` header. Hand-rolled (no dependency): split on `;`,
 * take the first `=`, trim, and compare the name exactly. Returns undefined when the header is
 * absent or the cookie is not present. Values are percent-decoded only if decoding succeeds —
 * our ids are hex, so this never matters in practice but keeps a malformed value from throwing.
 */
export function parseCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * Create the session store. Any existing sessions in `file` are loaded (expired ones dropped);
 * an unreadable or malformed file is treated as empty rather than fatal — a corrupt session file
 * must never stop the server from booting, it only costs one re-login.
 */
export function createUiSessionStore(opts: UiSessionStoreOptions = {}): UiSessionStore {
  const ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_SESSION_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const file = opts.file;
  const sessions = new Map<string, number>(); // id → expiresAt

  const load = (): void => {
    if (!file) return;
    let parsed: Persisted;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as Persisted;
    } catch {
      return; // absent or corrupt → start empty
    }
    if (!parsed || typeof parsed !== 'object') return;
    const t = now();
    for (const [id, exp] of Object.entries(parsed)) {
      if (typeof exp === 'number' && exp > t) sessions.set(id, exp);
    }
  };

  const persist = (): void => {
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
      renameSync(tmp, file); // atomic swap so a crash mid-write cannot truncate the live file
    } catch (e) {
      log.warn(`could not persist UI sessions: ${(e as Error).message}`);
    }
  };

  /** Drop expired entries. Returns true when anything was removed (caller decides to persist). */
  const prune = (): boolean => {
    const t = now();
    let dropped = false;
    for (const [id, exp] of sessions) {
      if (exp <= t) {
        sessions.delete(id);
        dropped = true;
      }
    }
    return dropped;
  };

  load();

  return {
    create(): string {
      prune();
      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, now() + ttlMs);
      persist();
      return id;
    },

    // Walks every live session with a constant-time comparison rather than a Map lookup: the id is
    // a secret, and a hash-table hit/miss is the one thing we do not want to leak by timing. The
    // set is a handful of browsers, so the linear scan is free.
    verify(sid: string | undefined): boolean {
      if (!sid) return false;
      const t = now();
      let ok = false;
      for (const [id, exp] of sessions) {
        if (timingSafeEqualStr(id, sid) && exp > t) ok = true;
      }
      return ok;
    },

    revoke(sid: string | undefined): void {
      if (!sid) return;
      const had = sessions.delete(sid);
      const pruned = prune();
      if (had || pruned) persist();
    },

    size(): number {
      prune();
      return sessions.size;
    },
  };
}
