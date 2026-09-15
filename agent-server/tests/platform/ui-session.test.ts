import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createUiSessionStore,
  parseCookie,
  DEFAULT_SESSION_TTL_MS,
} from '@platform/ui-http/ui-session.js';

function tmpFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-ui-session-'));
  return { file: path.join(dir, 'ui-sessions.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('parseCookie', () => {
  it('picks the named cookie out of a multi-cookie header', () => {
    expect(parseCookie('a=1; cortex_ui=abc123; b=2', 'cortex_ui')).toBe('abc123');
  });

  it('does not match on a name that is only a suffix/prefix of another cookie', () => {
    // `x_cortex_ui` must not answer a request for `cortex_ui`.
    expect(parseCookie('x_cortex_ui=wrong', 'cortex_ui')).toBeUndefined();
    expect(parseCookie('cortex_ui_extra=wrong', 'cortex_ui')).toBeUndefined();
  });

  it('returns undefined for an absent header or an absent cookie', () => {
    expect(parseCookie(undefined, 'cortex_ui')).toBeUndefined();
    expect(parseCookie('a=1', 'cortex_ui')).toBeUndefined();
  });

  it('survives a malformed percent-encoded value instead of throwing', () => {
    expect(parseCookie('cortex_ui=%FF', 'cortex_ui')).toBe('%FF');
  });
});

describe('ui session store', () => {
  it('admits an id it minted and rejects everything else', () => {
    const store = createUiSessionStore();
    const id = store.create();
    expect(store.verify(id)).toBe(true);
    expect(store.verify('not-a-session')).toBe(false);
    expect(store.verify(undefined)).toBe(false);
    expect(store.verify('')).toBe(false);
  });

  it('mints unpredictable 32-byte ids', () => {
    const store = createUiSessionStore();
    const ids = new Set(Array.from({ length: 20 }, () => store.create()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires a session at its absolute TTL, and verify never renews it', () => {
    let clock = 1_000_000;
    const store = createUiSessionStore({ ttlMs: 1000, now: () => clock });
    const id = store.create();
    clock += 900;
    expect(store.verify(id)).toBe(true); // still alive — and this must NOT push the deadline out
    clock += 200;
    expect(store.verify(id)).toBe(false);
    expect(store.size()).toBe(0);
  });

  it('revokes one session without touching the others (logout is per-browser)', () => {
    const store = createUiSessionStore();
    const a = store.create();
    const b = store.create();
    store.revoke(a);
    expect(store.verify(a)).toBe(false);
    expect(store.verify(b)).toBe(true);
    store.revoke('unknown'); // no-op, must not throw
    expect(store.size()).toBe(1);
  });

  it('survives a daemon restart: sessions round-trip through the file at 0600', () => {
    const { file, cleanup } = tmpFile();
    try {
      const first = createUiSessionStore({ file });
      const id = first.create();
      expect(statSync(file).mode & 0o777).toBe(0o600);

      const second = createUiSessionStore({ file }); // "restart"
      expect(second.verify(id)).toBe(true);

      second.revoke(id);
      const third = createUiSessionStore({ file });
      expect(third.verify(id)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('drops already-expired sessions when loading the file', () => {
    const { file, cleanup } = tmpFile();
    try {
      writeFileSync(file, JSON.stringify({ stale: Date.now() - 1000, fresh: Date.now() + 60_000 }));
      const store = createUiSessionStore({ file });
      expect(store.verify('stale')).toBe(false);
      expect(store.verify('fresh')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('treats a corrupt session file as empty rather than failing to boot', () => {
    const { file, cleanup } = tmpFile();
    try {
      writeFileSync(file, '{not json');
      const store = createUiSessionStore({ file });
      expect(store.size()).toBe(0);
      expect(store.verify(store.create())).toBe(true); // still usable
      expect(JSON.parse(readFileSync(file, 'utf8'))).toBeTypeOf('object');
    } finally {
      cleanup();
    }
  });

  it('defaults to a 30-day lifetime', () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
