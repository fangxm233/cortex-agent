// input:  UI HTTP host, entry wiring, mutable settings, auth fakes
// output: transport, auth, CORS, SPA, OTA, and download regressions
// pos:    Web UI HTTP transport integration tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { describe, test, beforeAll, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { generateKeyPair, exportJWK, SignJWT, type JWK, type CryptoKey } from 'jose';
import { createUiHttpServer } from '@platform/ui-http/ui-http-server.js';
import { createAccessJwtVerifier, accessVerifierFromEnv } from '@platform/ui-http/access-jwt.js';
import type { AccessJwtVerifier } from '@platform/ui-http/access-jwt.js';
import { startUiHttpServer, resolveWorkspacePath } from '@entry/start-ui-http.js';
import { UI_OTA_MANIFEST_PATH, UI_OTA_BUNDLE_PATH } from '@platform/ui-http/ui-ota.js';
import { APP_UPDATE_MANIFEST_PATH } from '@platform/ui-http/app-update.js';
import { WORKSPACE_DIR } from '@core/paths.js';
import type { UiService, UiEvent } from '@domain/ui-service/types.js';

const liveSettings = vi.hoisted(() => ({ uiCorsOrigins: [] as string[] }));
vi.mock('@core/settings.js', () => ({ getSettings: () => liveSettings }));

const TOKEN = 'test-ui-token-xyz';
const INDEX_MARKER = '<!-- CORTEX-UI-STUB-INDEX -->';
const SSE_MARKER = 'EVENT_ONE_MARKER';
const WIRING_SSE_MARKER = 'WIRING_EVENT_MARKER';

// ── Fake tRPC router (built off @trpc/server directly — no real AppRouter dependency) ──
const t = initTRPC.create();
const fakeRouter = t.router({
  ping: t.procedure.input(z.object({ v: z.string() })).query(({ input }) => ({ echoed: input.v })),
  tick: t.procedure.subscription(async function* ({ signal }) {
    yield { marker: SSE_MARKER, n: 1 };
    // Stay open until the client/server aborts, so close() must force-close a live SSE socket.
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve());
    });
  }),
});

// ── Shared cleanup: every booted server / JWKS server / temp dir registered here ──
const servers: Array<{ close: () => Promise<void> }> = [];
const jwksServers: http.Server[] = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  for (const s of jwksServers) await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function awaitListening(server: http.Server): Promise<{ port: number; host: string }> {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
  }
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no TCP address');
  return { port: addr.port, host: addr.address };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
interface Res { statusCode: number; body: string; headers: http.IncomingHttpHeaders }
function req(
  port: number,
  method: 'GET' | 'POST' | 'OPTIONS',
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: buf, headers: res.headers }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const get = (port: number, urlPath: string, headers: Record<string, string> = {}) =>
  req(port, 'GET', urlPath, headers);

const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));
const pingPath = () => `/trpc/ping?input=${enc({ v: 'hi' })}`;

/** Open an SSE stream and resolve with the buffered payload once `marker` appears. */
function sseAwait(port: number, urlPath: string, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = http.get(
      { host: '127.0.0.1', port, path: urlPath, headers: { 'x-cortex-token': TOKEN, Accept: 'text/event-stream' } },
      (res) => {
        assert.equal(res.statusCode, 200);
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.includes(marker)) { r.destroy(); resolve(buf); }
        });
        res.on('error', () => { /* destroyed by us */ });
      },
    );
    r.on('error', (e) => { if (!String(e).includes('aborted')) reject(e); });
    setTimeout(() => reject(new Error('SSE timeout — no event received')), 5000).unref();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Transport-host: createUiHttpServer + fake router (task d7c2, edf0/B, 1b60)
// ═════════════════════════════════════════════════════════════════════════════

const ALLOWED_ORIGIN = 'tauri://localhost';
const BLOCKED_ORIGIN = 'https://evil.example.com';

async function bootTransport(
  opts: { spaDir?: string; corsOrigins?: string[]; verifyAccessJwt?: AccessJwtVerifier } = {},
) {
  const inst = createUiHttpServer({
    router: fakeRouter,
    getToken: () => TOKEN,
    port: 0,
    host: '127.0.0.1',
    ...opts,
  });
  servers.push(inst);
  const { port, host } = await awaitListening(inst.server);
  return { inst, port, host };
}

describe('transport-host: server, token gate, SPA static, CORS', () => {
  // Shared read-only servers: none of these tests mutate server state.
  let plain: { port: number; host: string };  // no spaDir, no CORS
  let spa: { port: number };                  // temp SPA dir with index.html
  let cors: { port: number };                 // corsOrigins: [ALLOWED_ORIGIN]

  beforeAll(async () => {
    plain = await bootTransport();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-spa-'));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'index.html'), `<html><body>${INDEX_MARKER}</body></html>`);
    spa = await bootTransport({ spaDir: dir });
    cors = await bootTransport({ corsOrigins: [ALLOWED_ORIGIN] });
  });

  test('bind: server listens on 127.0.0.1', () => {
    assert.equal(plain.host, '127.0.0.1');
  });

  test('auth: tRPC request without a token is rejected 401', async () => {
    const { statusCode } = await get(plain.port, pingPath());
    assert.equal(statusCode, 401);
  });

  test('auth: tRPC request with a wrong token is rejected 401', async () => {
    const { statusCode } = await get(plain.port, pingPath(), { 'x-cortex-token': 'nope' });
    assert.equal(statusCode, 401);
  });

  test('query: HTTP query roundtrip with the correct token returns 200 + data', async () => {
    const { statusCode, body } = await get(plain.port, `/trpc/ping?input=${enc({ v: 'hello' })}`, { 'x-cortex-token': TOKEN });
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(body).result.data, { echoed: 'hello' });
  });

  test('subscription: SSE receives one event', async () => {
    const received = await sseAwait(plain.port, '/trpc/tick', SSE_MARKER);
    assert.ok(received.includes(SSE_MARKER));
  });

  test('static stub: spaDir present serves index.html', async () => {
    const { statusCode, body } = await get(spa.port, '/');
    assert.equal(statusCode, 200);
    assert.ok(body.includes(INDEX_MARKER));
  });

  test('static stub: spaDir absent returns 404 placeholder', async () => {
    const { statusCode } = await get(plain.port, '/');
    assert.equal(statusCode, 404);
  });

  test('static stub: path traversal is rejected', async () => {
    const { statusCode } = await get(spa.port, '/../../etc/passwd');
    assert.ok(statusCode === 403 || statusCode === 404, `expected 403/404, got ${statusCode}`);
  });

  test('static stub: a malformed percent-encoded URL is rejected 400 (no crash)', async () => {
    // `%FF` is invalid UTF-8 percent-encoding → decodeURIComponent throws URIError.
    const { statusCode } = await get(spa.port, '/%FF');
    assert.equal(statusCode, 400);
    // Server survived — a well-formed follow-up still works.
    const ok = await get(spa.port, '/');
    assert.equal(ok.statusCode, 200);
  });

  test('close: shuts down cleanly (subsequent request refused)', async () => {
    const { inst, port } = await bootTransport(); // own server — this test kills it
    await inst.close();
    await assert.rejects(get(port, pingPath(), { 'x-cortex-token': TOKEN }));
  });

  // ── CORS allow-list (task 1b60) ─────────────────────────────────────────────
  test('cors: allowed origin gets an exact (non-wildcard) Access-Control-Allow-Origin', async () => {
    const { headers } = await get(cors.port, pingPath(), { 'x-cortex-token': TOKEN, 'origin': ALLOWED_ORIGIN });
    assert.equal(headers['access-control-allow-origin'], ALLOWED_ORIGIN,
      'ACAO header must be the exact allowed origin');
    assert.notEqual(headers['access-control-allow-origin'], '*', 'ACAO must not be wildcard');
  });

  test('cors: disallowed origin does NOT get ACAO header', async () => {
    const { headers } = await get(cors.port, pingPath(), { 'x-cortex-token': TOKEN, 'origin': BLOCKED_ORIGIN });
    assert.equal(headers['access-control-allow-origin'], undefined,
      'Disallowed origin must not receive ACAO');
  });

  test('cors: no corsOrigins configured → no CORS headers (backward-compat)', async () => {
    const { headers } = await get(plain.port, pingPath(), { 'x-cortex-token': TOKEN, 'origin': ALLOWED_ORIGIN });
    assert.equal(headers['access-control-allow-origin'], undefined,
      'No CORS config → no ACAO header');
  });

  test('cors: OPTIONS preflight returns 204 with CORS headers (no auth token required)', async () => {
    // No x-cortex-token — browser sends preflight BEFORE the actual request with headers
    const { statusCode, headers } = await req(
      cors.port, 'OPTIONS', '/trpc/ping',
      { 'origin': ALLOWED_ORIGIN, 'access-control-request-headers': 'x-cortex-token' },
    );
    assert.equal(statusCode, 204, 'Preflight must return 204 No Content');
    assert.equal(headers['access-control-allow-origin'], ALLOWED_ORIGIN);
    // x-cortex-token must be in the allowed headers
    const allowedHeaders = (headers['access-control-allow-headers'] ?? '').toLowerCase();
    assert.ok(allowedHeaders.includes('x-cortex-token'),
      `access-control-allow-headers must include x-cortex-token; got: ${allowedHeaders}`);
  });

  test('cors: 401 response for bad token still carries ACAO (browser can read error body)', async () => {
    const { statusCode, headers } = await get(cors.port, pingPath(), { 'x-cortex-token': 'wrong-token', 'origin': ALLOWED_ORIGIN });
    assert.equal(statusCode, 401);
    assert.equal(headers['access-control-allow-origin'], ALLOWED_ORIGIN,
      '401 responses must still carry ACAO so the browser can read the error body');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Entry wiring: startUiHttpServer + fake UiService (task 3af2, edf0/C)
// Drives the REAL wiring code path with an injected fake UiService — proves the
// injected service threads through createAppRouter to a token-gated HTTP/SSE
// server on the configured port. The token gate / close / CORS-deny / preflight
// logic itself lives in the transport-host and is pinned above — the wiring
// tests here only pin what the wiring layer ADDS (env parsing, AppRouter
// binding, custom routes).
// ═════════════════════════════════════════════════════════════════════════════

// Fake UiService: deterministic Ok data for one query + one mutate + a subscription.
function makeFakeUiService(): UiService {
  return {
    query: (async (scope: string) => {
      if (scope === 'projects.list') {
        return { ok: true, data: [{ id: 'demo', kind: 'general', contextDir: '/x', hasMission: false, conduits: {} }] };
      }
      return { ok: false, code: 'not-found', message: `unexpected scope ${scope}` };
    }) as UiService['query'],
    mutate: (async (op: string) => {
      if (op === 'threads.cancel') return { ok: true, data: { cancelled: true } };
      return { ok: false, code: 'not-found', message: `unexpected op ${op}` };
    }) as UiService['mutate'],
    subscribe: () => makeOneShotStream(),
    subscribeExecutionLog: () => makeOneShotStream(),
  };
}

/** One-shot subscription stub: yields a single SSE marker event, then ends. */
function makeOneShotStream(): AsyncIterable<UiEvent> & { close(): void } {
  let done = false;
  const iterator: AsyncIterator<UiEvent> = {
    async next() {
      if (done) return { value: undefined as unknown as UiEvent, done: true };
      done = true;
      return { value: { type: WIRING_SSE_MARKER, ts: new Date().toISOString(), payload: { n: 1 } }, done: false };
    },
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
    close: () => { done = true; },
  };
}

async function bootWiring(env: Record<string, string>, spaDir?: string, corsOrigins?: string[]) {
  const inst = startUiHttpServer({ uiService: makeFakeUiService(), getToken: () => TOKEN, env, spaDir, corsOrigins });
  assert.ok(inst, 'expected a server when CORTEX_UI_HTTP is enabled');
  servers.push(inst!);
  const { port } = await awaitListening(inst!.server);
  return { inst: inst!, port };
}

describe('entry wiring: env gate, AppRouter binding, live CORS, OTA, download', () => {
  const CORS_ORIGIN = 'tauri://localhost';
  // Shared read-only servers.
  let w: { port: number };     // plain wiring server (empty settings allow-list)
  let wCors: { port: number }; // explicit static CORS override
  let wOta: { port: number };  // spaDir present → OTA + app-update routes mounted

  beforeAll(async () => {
    w = await bootWiring({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' });
    wCors = await bootWiring(
      { CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' },
      undefined,
      ['http://tauri.localhost', CORS_ORIGIN],
    );
    const otaDir = mkdtempSync(path.join(os.tmpdir(), 'cortex-ota-wire-'));
    tmpDirs.push(otaDir);
    writeFileSync(path.join(otaDir, 'index.html'), '<html><body>OTA</body></html>');
    writeFileSync(path.join(otaDir, 'app.js'), 'console.log(1)');
    wOta = await bootWiring({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' }, otaDir);
  });

  test('env gate: disabled (unset) returns null — clean skip', () => {
    const inst = startUiHttpServer({ uiService: makeFakeUiService(), env: {} });
    assert.equal(inst, null);
  });

  test('env gate: enabled binds 127.0.0.1 and defaults to port 3004', async () => {
    // Intent: with CORTEX_UI_HTTP set and CORTEX_UI_PORT unset, the wiring targets the default 3004.
    // 3004 is a fixed real port, so on a dev box where a live daemon already holds 3004 the bind
    // throws EADDRINUSE for :3004 — which still proves the default is 3004. Accept either a clean
    // bind to 127.0.0.1:3004, or an EADDRINUSE naming :3004.
    const inst = startUiHttpServer({ uiService: makeFakeUiService(), getToken: () => TOKEN, env: { CORTEX_UI_HTTP: '1' } });
    assert.ok(inst, 'expected a server when enabled');
    servers.push(inst!);
    try {
      await awaitListening(inst!.server);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      assert.ok(msg.includes('EADDRINUSE') && msg.includes('3004'),
        `expected a clean bind to 3004 or an EADDRINUSE on :3004, got: ${msg}`);
      return;
    }
    const addr = inst!.server.address();
    assert.ok(addr && typeof addr !== 'string');
    assert.equal((addr as { address: string }).address, '127.0.0.1');
    assert.equal((addr as { port: number }).port, 3004);
    await inst!.close(); // free 3004 immediately — don't hold a fixed port until afterAll
  });

  test('query: HTTP query roundtrip returns real data from the injected UiService', async () => {
    const { statusCode, body } = await get(w.port, `/trpc/projects.list?input=${enc({})}`, { 'x-cortex-token': TOKEN });
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(body).result.data,
      [{ id: 'demo', kind: 'general', contextDir: '/x', hasMission: false, conduits: {} }]);
  });

  test('mutate: HTTP mutation roundtrip routes to the injected UiService and unwraps Result', async () => {
    const { statusCode, body } = await req(
      w.port, 'POST', '/trpc/threads.cancel',
      { 'x-cortex-token': TOKEN, 'content-type': 'application/json' },
      JSON.stringify({ threadId: 'abc' }),
    );
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(body).result.data, { cancelled: true });
  });

  test('subscription: SSE receives an event from the injected UiService', async () => {
    const received = await sseAwait(w.port, `/trpc/subscribe?input=${enc({ events: ['*'] })}`, WIRING_SSE_MARKER);
    assert.ok(received.includes(WIRING_SSE_MARKER));
  });

  // ── CORS entry wiring ─────────────────────────────────────────────────────

  test('cors option: an explicit static allow-list gets ACAO echoed', async () => {
    const { statusCode, headers } = await get(
      wCors.port, `/trpc/projects.list?input=${enc({})}`,
      { 'x-cortex-token': TOKEN, origin: CORS_ORIGIN },
    );
    assert.equal(statusCode, 200);
    assert.equal(headers['access-control-allow-origin'], CORS_ORIGIN,
      'ACAO must be the exact allow-listed origin');
  });

  test('cors option: each configured static origin matches', async () => {
    const { headers } = await get(
      wCors.port, `/trpc/projects.list?input=${enc({})}`,
      { 'x-cortex-token': TOKEN, origin: 'http://tauri.localhost' },
    );
    assert.equal(headers['access-control-allow-origin'], 'http://tauri.localhost');
  });

  test('cors settings: a runtime allow-list flip affects the next request', async () => {
    const nextOrigin = 'cortexui://localhost';
    liveSettings.uiCorsOrigins = [CORS_ORIGIN];
    const hot = await bootWiring({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' });
    try {
      const first = await get(
        hot.port, `/trpc/projects.list?input=${enc({})}`,
        { 'x-cortex-token': TOKEN, origin: CORS_ORIGIN },
      );
      assert.equal(first.headers['access-control-allow-origin'], CORS_ORIGIN);

      liveSettings.uiCorsOrigins = [nextOrigin];
      const oldOrigin = await get(
        hot.port, `/trpc/projects.list?input=${enc({})}`,
        { 'x-cortex-token': TOKEN, origin: CORS_ORIGIN },
      );
      const newOrigin = await get(
        hot.port, `/trpc/projects.list?input=${enc({})}`,
        { 'x-cortex-token': TOKEN, origin: nextOrigin },
      );
      assert.equal(oldOrigin.headers['access-control-allow-origin'], undefined);
      assert.equal(newOrigin.headers['access-control-allow-origin'], nextOrigin);
    } finally {
      liveSettings.uiCorsOrigins = [];
      await hot.inst.close();
    }
  });

  test('cors settings: empty uiCorsOrigins emits no CORS headers', async () => {
    const { headers } = await get(
      w.port, `/trpc/projects.list?input=${enc({})}`,
      { 'x-cortex-token': TOKEN, origin: CORS_ORIGIN },
    );
    assert.equal(headers['access-control-allow-origin'], undefined,
      'empty settings → transport-host keeps its no-CORS default');
  });

  // ── Frontend OTA wiring (desktop OTA, unit A) ───────────────────────────────
  // startUiHttpServer must mount the OTA manifest + bundle routes when a SPA dir is present, gated
  // by the same x-cortex-token check as tRPC.

  test('ota: manifest without a token is rejected 401', async () => {
    const { statusCode } = await get(wOta.port, UI_OTA_MANIFEST_PATH);
    assert.equal(statusCode, 401);
  });

  test('ota: manifest with the token returns 200 + a valid manifest pointing at the bundle', async () => {
    const { statusCode, body, headers } = await get(wOta.port, UI_OTA_MANIFEST_PATH, { 'x-cortex-token': TOKEN });
    assert.equal(statusCode, 200);
    assert.match(String(headers['content-type']), /application\/json/);
    const m = JSON.parse(body);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.size > 0);
    // The bundle url is content-addressed: bare path + a `?v=<sha256>` cache-buster.
    assert.ok(m.url.startsWith(UI_OTA_BUNDLE_PATH), `url should point at the bundle path: ${m.url}`);
    assert.match(m.url, /\?v=[0-9a-f]{64}$/);
  });

  test('ota: bundle with the token returns 200 application/zip', async () => {
    const { statusCode, headers } = await get(wOta.port, UI_OTA_BUNDLE_PATH, { 'x-cortex-token': TOKEN });
    assert.equal(statusCode, 200);
    assert.match(String(headers['content-type']), /application\/zip/);
  });

  // ── App-update manifest route (shell self-update) ───────────────────────────
  // A 401 (not a SPA fallback / 404) proves the path is registered as a custom route AND
  // auth-gated; the with-token manifest behavior is covered hermetically in app-update.test.ts
  // (no GitHub call here).

  test('app-update: manifest without a token is rejected 401', async () => {
    const { statusCode } = await get(wOta.port, APP_UPDATE_MANIFEST_PATH);
    assert.equal(statusCode, 401);
  });

  // ── File download route (15a uploads + 20a agent-sent files) ────────────────
  // Serves a file stored under WORKSPACE_DIR by its UI-relative `workspace/…` path, auth-gated,
  // confined to the workspace root by a traversal guard.

  test('resolveWorkspacePath: confines to WORKSPACE_DIR and rejects traversal / wrong prefix', () => {
    const ok = resolveWorkspacePath('workspace/outputs/s1/a.txt');
    assert.ok(ok && ok.startsWith(path.resolve(WORKSPACE_DIR) + path.sep));
    assert.equal(resolveWorkspacePath('workspace/../../etc/passwd'), null, 'traversal escapes → null');
    assert.equal(resolveWorkspacePath('outputs/s1/a.txt'), null, 'missing workspace/ prefix → null');
    assert.equal(resolveWorkspacePath('/etc/passwd'), null, 'absolute path → null');
  });

  test('download: without a token is rejected 401', async () => {
    const { statusCode } = await get(w.port, `${'/api/files/download'}?path=workspace/outputs/x/a.txt`);
    assert.equal(statusCode, 401);
  });

  test('download: with the token streams a real workspace file with its content type', async () => {
    const dir = path.join(WORKSPACE_DIR, 'outputs', 'dl-sess');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'hello.txt'), 'hello world');
    const { statusCode, body, headers } = await get(
      w.port, `/api/files/download?path=${encodeURIComponent('workspace/outputs/dl-sess/hello.txt')}`,
      { 'x-cortex-token': TOKEN },
    );
    assert.equal(statusCode, 200);
    assert.equal(body, 'hello world');
    assert.match(String(headers['content-type']), /text\/plain/);
    assert.match(String(headers['content-disposition']), /attachment; filename="hello\.txt"/);
  });

  test('download: inline disposition is honored (for image preview)', async () => {
    const dir = path.join(WORKSPACE_DIR, 'outputs', 'dl-img');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'p.png'), 'PNGDATA');
    const { headers } = await get(
      w.port, `/api/files/download?path=${encodeURIComponent('workspace/outputs/dl-img/p.png')}&disposition=inline`,
      { 'x-cortex-token': TOKEN },
    );
    assert.match(String(headers['content-type']), /image\/png/);
    assert.match(String(headers['content-disposition']), /^inline;/);
  });

  test('download: a traversal path is rejected 403', async () => {
    const { statusCode } = await get(
      w.port, `/api/files/download?path=${encodeURIComponent('workspace/../../etc/passwd')}`,
      { 'x-cortex-token': TOKEN },
    );
    assert.equal(statusCode, 403);
  });

  test('download: a missing file returns 404', async () => {
    const { statusCode } = await get(
      w.port, `/api/files/download?path=${encodeURIComponent('workspace/outputs/nope/ghost.txt')}`,
      { 'x-cortex-token': TOKEN },
    );
    assert.equal(statusCode, 404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Same-origin SPA serving (task 3606, done_when 5): a SINGLE port serves BOTH
// the built SPA (index.html) same-origin AND the token-gated /trpc endpoint,
// with the spaDir resolved from CORTEX_UI_SPA_DIR (the default-spaDir path).
// ═════════════════════════════════════════════════════════════════════════════

describe('same-origin SPA', () => {
  test('one port serves index.html (from CORTEX_UI_SPA_DIR) AND gates /trpc', async () => {
    const SAME_ORIGIN_MARKER = '<!-- CORTEX-UI-SAME-ORIGIN-INDEX -->';
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-web-dist-'));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'index.html'), `<html><body>${SAME_ORIGIN_MARKER}</body></html>`);

    // No opts.spaDir — the package must resolve it from CORTEX_UI_SPA_DIR (the default-spaDir path).
    const { port } = await bootWiring({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0', CORTEX_UI_SPA_DIR: dir });

    // SPA served same-origin at /
    const index = await get(port, '/');
    assert.equal(index.statusCode, 200);
    assert.ok(index.body.includes(SAME_ORIGIN_MARKER), 'GET / must serve index.html from the resolved spaDir');

    // Same port also hosts /trpc, still token-gated (401 without a token).
    const trpcNoAuth = await get(port, `/trpc/projects.list?input=${enc({})}`);
    assert.equal(trpcNoAuth.statusCode, 401);

    // With the token, /trpc returns 200 from the injected UiService.
    const trpcAuth = await get(port, `/trpc/projects.list?input=${enc({})}`, { 'x-cortex-token': TOKEN });
    assert.equal(trpcAuth.statusCode, 200);
    assert.deepEqual(JSON.parse(trpcAuth.body).result.data,
      [{ id: 'demo', kind: 'general', contextDir: '/x', hasMission: false, conduits: {} }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cloudflare Access JWT dual-path auth gate (task 50c7)
// Keypairs are signed ONCE; one shared JWKS server advertises the good RS256 +
// ES256 keys (the attacker key is deliberately NOT advertised); one shared UI
// server with the verifier + one without (secure degrade).
// ═════════════════════════════════════════════════════════════════════════════

const ACCESS_HEADER = 'cf-access-jwt-assertion';
const ISSUER = 'https://myteam.cloudflareaccess.com';
const AUD = 'test-aud-tag-0123456789abcdef';

interface Keypair { priv: CryptoKey; pub: CryptoKey; jwk: JWK }
async function makeKeypair(alg: 'RS256' | 'ES256', kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } as JWK;
  return { priv: privateKey, pub: publicKey, jwk };
}

async function startJwks(jwks: JWK[]): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: jwks }));
  });
  jwksServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no JWKS addr');
  return `http://127.0.0.1:${addr.port}/certs`;
}

async function signJwt(
  key: CryptoKey,
  kid: string,
  alg: 'RS256' | 'ES256',
  opts: { iss?: string; aud?: string; exp?: string } = {},
): Promise<string> {
  return new SignJWT({ email: 'user@example.com' })
    .setProtectedHeader({ alg, kid })
    .setIssuedAt()
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.exp ?? '2h')
    .sign(key);
}

describe('Access JWT dual gate', () => {
  let rs: Keypair;       // good RS256 key, kid rs-1 — in the JWKS
  let ec: Keypair;       // good ES256 key, kid ec-1 — in the JWKS
  let attacker: Keypair; // RS256 with the SAME kid rs-1 — NOT in the JWKS
  let verified: { port: number }; // server with a verifier bound to the shared JWKS
  let bare: { port: number };     // server WITHOUT a verifier (secure degrade)

  beforeAll(async () => {
    [rs, ec, attacker] = await Promise.all([
      makeKeypair('RS256', 'rs-1'),
      makeKeypair('ES256', 'ec-1'),
      makeKeypair('RS256', 'rs-1'), // same kid, different key
    ]);
    const jwksUrl = await startJwks([rs.jwk, ec.jwk]); // JWKS advertises only the good keys
    verified = await bootTransport({
      verifyAccessJwt: createAccessJwtVerifier({ jwksUrl, audience: AUD, issuer: ISSUER }),
    });
    bare = await bootTransport(); // no verifier → verifyAccessJwt undefined (secure degrade)
  });

  // ── token path (unchanged behaviour, cross-checked here too) ──
  test('dual-gate: valid x-cortex-token passes even with a verifier configured', async () => {
    const { statusCode, body } = await get(verified.port, pingPath(), { 'x-cortex-token': TOKEN });
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(body).result.data, { echoed: 'hi' });
  });

  test('dual-gate: no credentials → 401', async () => {
    const { statusCode } = await get(verified.port, pingPath());
    assert.equal(statusCode, 401);
  });

  // ── Access-JWT path: valid ──
  test('dual-gate: valid RS256 Access JWT (correct aud/iss, unexpired) passes', async () => {
    const jwt = await signJwt(rs.priv, 'rs-1', 'RS256');
    const { statusCode, body } = await get(verified.port, pingPath(), { [ACCESS_HEADER]: jwt });
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(body).result.data, { echoed: 'hi' });
  });

  test('dual-gate: valid ES256 Access JWT passes (EC keypair)', async () => {
    const jwt = await signJwt(ec.priv, 'ec-1', 'ES256');
    const { statusCode } = await get(verified.port, pingPath(), { [ACCESS_HEADER]: jwt });
    assert.equal(statusCode, 200);
  });

  // ── Access-JWT path: rejected ──
  test('dual-gate: bad-signature JWT → 401 (signed by a different key, same kid in JWKS)', async () => {
    const jwt = await signJwt(attacker.priv, 'rs-1', 'RS256');
    const { statusCode } = await get(verified.port, pingPath(), { [ACCESS_HEADER]: jwt });
    assert.equal(statusCode, 401);
  });

  test('dual-gate: wrong-aud JWT → 401', async () => {
    const jwt = await signJwt(rs.priv, 'rs-1', 'RS256', { aud: 'some-other-aud' });
    const { statusCode } = await get(verified.port, pingPath(), { [ACCESS_HEADER]: jwt });
    assert.equal(statusCode, 401);
  });

  test('dual-gate: wrong-iss JWT → 401', async () => {
    const jwt = await signJwt(rs.priv, 'rs-1', 'RS256', { iss: 'https://evil.cloudflareaccess.com' });
    const { statusCode } = await get(verified.port, pingPath(), { [ACCESS_HEADER]: jwt });
    assert.equal(statusCode, 401);
  });

  test('dual-gate: expired JWT → 401', async () => {
    const jwt = await signJwt(rs.priv, 'rs-1', 'RS256', { exp: '-1h' });
    const { statusCode } = await get(verified.port, pingPath(), { [ACCESS_HEADER]: jwt });
    assert.equal(statusCode, 401);
  });

  test('dual-gate: Access JWT presented but no verifier configured (unset env) → 401', async () => {
    const jwt = await signJwt(rs.priv, 'rs-1', 'RS256');
    const { statusCode } = await get(bare.port, pingPath(), { [ACCESS_HEADER]: jwt });
    assert.equal(statusCode, 401);
  });

  // ── env-driven verifier construction (secure degrade) ──
  test('accessVerifierFromEnv: team-domain + aud present → returns a verifier', () => {
    const v = accessVerifierFromEnv({ CORTEX_ACCESS_TEAM_DOMAIN: 'myteam', CORTEX_ACCESS_AUD: AUD });
    assert.equal(typeof v, 'function');
  });

  test('accessVerifierFromEnv: missing team-domain → undefined (token-only degrade)', () => {
    assert.equal(accessVerifierFromEnv({ CORTEX_ACCESS_AUD: AUD }), undefined);
  });

  test('accessVerifierFromEnv: missing aud → undefined (token-only degrade)', () => {
    assert.equal(accessVerifierFromEnv({ CORTEX_ACCESS_TEAM_DOMAIN: 'myteam' }), undefined);
  });

  test('accessVerifierFromEnv: both missing → undefined', () => {
    assert.equal(accessVerifierFromEnv({}), undefined);
  });
});
