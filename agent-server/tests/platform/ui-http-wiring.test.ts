// input:  Node test runner + startUiHttpServer (entry wiring) + a FAKE UiService
// output: integration tests — env gate (enabled/disabled), default port 3004, token 401,
//         HTTP query roundtrip, HTTP mutate roundtrip, SSE subscription event, clean close(),
//         CORS via CORTEX_UI_CORS_ORIGINS env (allow-listed Origin echoed, preflight OPTIONS 204,
//         non-listed origin → none)
// pos:    Regression guard for the entry-layer wiring that builds createAppRouter(uiService)
//         and starts createUiHttpServer on CORTEX_UI_PORT behind getClientToken (task 3af2, edf0/C).
//         Drives the REAL wiring code path with an injected fake UiService (analogous to the
//         transport-host test's fake router) — proves the injected service threads through to a
//         token-gated HTTP/SSE server on the configured port.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startUiHttpServer } from '@entry/start-ui-http.js';
import { UI_OTA_MANIFEST_PATH, UI_OTA_BUNDLE_PATH } from '@platform/ui-http/ui-ota.js';
import type { UiService, UiEvent } from '@domain/ui-service/types.js';

const TOKEN = 'test-wiring-token';
const SSE_MARKER = 'WIRING_EVENT_MARKER';

// ── Fake UiService: deterministic Ok data for one query + one mutate + a subscription ──
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
      return { value: { type: SSE_MARKER, ts: new Date().toISOString(), payload: { n: 1 } }, done: false };
    },
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
    close: () => { done = true; },
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
after(async () => {
  for (const s of servers) await s.close().catch(() => {});
});

async function boot(env: Record<string, string>) {
  const inst = startUiHttpServer({ uiService: makeFakeUiService(), getToken: () => TOKEN, env });
  if (inst) {
    servers.push(inst);
    if (!inst.server.listening) {
      await new Promise<void>((resolve, reject) => {
        inst.server.once('listening', () => resolve());
        inst.server.once('error', reject);
      });
    }
  }
  return inst;
}

function portOf(inst: { server: http.Server }): number {
  const addr = inst.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no TCP address');
  return addr.port;
}

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

const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));

test('env gate: disabled (unset) returns null — clean skip', () => {
  const inst = startUiHttpServer({ uiService: makeFakeUiService(), env: {} });
  assert.equal(inst, null);
});

test('env gate: enabled binds 127.0.0.1 and defaults to port 3004', async () => {
  // Intent: with CORTEX_UI_HTTP set and CORTEX_UI_PORT unset, the wiring targets the default 3004.
  // 3004 is a fixed real port, so on a dev box where a live daemon already holds 3004 the bind
  // throws EADDRINUSE for :3004 — which still proves the default is 3004. Accept either a clean
  // bind to 127.0.0.1:3004, or an EADDRINUSE naming :3004.
  let inst: Awaited<ReturnType<typeof boot>> | null = null;
  try {
    inst = await boot({ CORTEX_UI_HTTP: '1' });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    assert.ok(msg.includes('EADDRINUSE') && msg.includes('3004'),
      `expected a clean bind to 3004 or an EADDRINUSE on :3004, got: ${msg}`);
    return;
  }
  assert.ok(inst, 'expected a server when enabled');
  const addr = inst.server.address();
  assert.ok(addr && typeof addr !== 'string');
  assert.equal((addr as { address: string }).address, '127.0.0.1');
  assert.equal((addr as { port: number }).port, 3004);
});

test('auth: query without a token is rejected 401', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' });
  const { statusCode } = await req(portOf(inst!), 'GET', `/trpc/projects.list?input=${enc({})}`);
  assert.equal(statusCode, 401);
});

test('query: HTTP query roundtrip returns real data from the injected UiService', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' });
  const { statusCode, body } = await req(
    portOf(inst!), 'GET', `/trpc/projects.list?input=${enc({})}`, { 'x-cortex-token': TOKEN },
  );
  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.result.data, [{ id: 'demo', kind: 'general', contextDir: '/x', hasMission: false, conduits: {} }]);
});

test('mutate: HTTP mutation roundtrip routes to the injected UiService and unwraps Result', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' });
  const { statusCode, body } = await req(
    portOf(inst!), 'POST', '/trpc/threads.cancel',
    { 'x-cortex-token': TOKEN, 'content-type': 'application/json' },
    JSON.stringify({ threadId: 'abc' }),
  );
  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.result.data, { cancelled: true });
});

test('subscription: SSE receives an event from the injected UiService', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' });
  const port = portOf(inst!);
  const received = await new Promise<string>((resolve, reject) => {
    const r = http.get(
      { host: '127.0.0.1', port, path: `/trpc/subscribe?input=${enc({ events: ['*'] })}`,
        headers: { 'x-cortex-token': TOKEN, Accept: 'text/event-stream' } },
      (res) => {
        assert.equal(res.statusCode, 200);
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.includes(SSE_MARKER)) { r.destroy(); resolve(buf); }
        });
        res.on('error', () => { /* destroyed by us */ });
      },
    );
    r.on('error', (e) => { if (!String(e).includes('aborted')) reject(e); });
    setTimeout(() => reject(new Error('SSE timeout — no event received')), 5000).unref();
  });
  assert.ok(received.includes(SSE_MARKER));
});

test('close: shuts down cleanly (subsequent request refused)', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' });
  const port = portOf(inst!);
  await inst!.close();
  await assert.rejects(req(port, 'GET', `/trpc/projects.list?input=${enc({})}`, { 'x-cortex-token': TOKEN }));
});

// ── CORS wiring via CORTEX_UI_CORS_ORIGINS env (the running-server path in app.ts) ──
// Proves the entry wiring parses the env var and threads the allow-list all the way to the
// transport-host, so app.ts (which never passes opts.corsOrigins) honors CORS purely via env.
const CORS_ORIGIN = 'tauri://localhost';

test('cors env: allow-listed Origin from CORTEX_UI_CORS_ORIGINS gets ACAO echoed', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0', CORTEX_UI_CORS_ORIGINS: CORS_ORIGIN });
  const { statusCode, headers } = await req(
    portOf(inst!), 'GET', `/trpc/projects.list?input=${enc({})}`,
    { 'x-cortex-token': TOKEN, origin: CORS_ORIGIN },
  );
  assert.equal(statusCode, 200);
  assert.equal(headers['access-control-allow-origin'], CORS_ORIGIN,
    'ACAO must be the exact allow-listed origin, proving the env var reached the transport-host');
});

test('cors env: comma-separated list is parsed (trim + drop empties) and each entry matches', async () => {
  const inst = await boot({
    CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0',
    // Intentional whitespace + a trailing empty entry to prove trim + filter.
    CORTEX_UI_CORS_ORIGINS: ` http://tauri.localhost , ${CORS_ORIGIN} , `,
  });
  const { headers } = await req(
    portOf(inst!), 'GET', `/trpc/projects.list?input=${enc({})}`,
    { 'x-cortex-token': TOKEN, origin: CORS_ORIGIN },
  );
  assert.equal(headers['access-control-allow-origin'], CORS_ORIGIN);
});

test('cors env: preflight OPTIONS for a tRPC path returns 204 with ACAO (no auth token)', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0', CORTEX_UI_CORS_ORIGINS: CORS_ORIGIN });
  const { statusCode, headers } = await req(
    portOf(inst!), 'OPTIONS', '/trpc/projects.list',
    { origin: CORS_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-cortex-token' },
  );
  assert.equal(statusCode, 204, 'preflight must be 204 No Content');
  assert.equal(headers['access-control-allow-origin'], CORS_ORIGIN);
});

test('cors env: a non-listed Origin gets no ACAO header', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0', CORTEX_UI_CORS_ORIGINS: CORS_ORIGIN });
  const { headers } = await req(
    portOf(inst!), 'GET', `/trpc/projects.list?input=${enc({})}`,
    { 'x-cortex-token': TOKEN, origin: 'https://evil.example.com' },
  );
  assert.equal(headers['access-control-allow-origin'], undefined,
    'a non-allow-listed origin must not receive ACAO');
});

test('cors env: unset CORTEX_UI_CORS_ORIGINS → no CORS headers (backward-compat)', async () => {
  const inst = await boot({ CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' });
  const { headers } = await req(
    portOf(inst!), 'GET', `/trpc/projects.list?input=${enc({})}`,
    { 'x-cortex-token': TOKEN, origin: CORS_ORIGIN },
  );
  assert.equal(headers['access-control-allow-origin'], undefined,
    'no env var → transport-host keeps its no-CORS default');
});

// ── Frontend OTA wiring (desktop OTA, unit A) ─────────────────────────────────
// startUiHttpServer must mount the OTA manifest + bundle routes when a SPA dir is present, gated by
// the same x-cortex-token check as tRPC.
const otaTmpDirs: string[] = [];
after(() => { for (const d of otaTmpDirs) rmSync(d, { recursive: true, force: true }); });

function makeSpaDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-ota-wire-'));
  otaTmpDirs.push(dir);
  writeFileSync(path.join(dir, 'index.html'), '<html><body>OTA</body></html>');
  writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  return dir;
}

async function bootWithSpa(spaDir: string) {
  const inst = startUiHttpServer({
    uiService: makeFakeUiService(),
    getToken: () => TOKEN,
    env: { CORTEX_UI_HTTP: '1', CORTEX_UI_PORT: '0' },
    spaDir,
  });
  assert.ok(inst, 'expected a server');
  servers.push(inst);
  if (!inst.server.listening) {
    await new Promise<void>((resolve, reject) => {
      inst.server.once('listening', () => resolve());
      inst.server.once('error', reject);
    });
  }
  return inst;
}

test('ota: manifest without a token is rejected 401', async () => {
  const inst = await bootWithSpa(makeSpaDir());
  const { statusCode } = await req(portOf(inst), 'GET', UI_OTA_MANIFEST_PATH);
  assert.equal(statusCode, 401);
});

test('ota: manifest with the token returns 200 + a valid manifest pointing at the bundle', async () => {
  const inst = await bootWithSpa(makeSpaDir());
  const { statusCode, body, headers } = await req(
    portOf(inst), 'GET', UI_OTA_MANIFEST_PATH, { 'x-cortex-token': TOKEN },
  );
  assert.equal(statusCode, 200);
  assert.match(String(headers['content-type']), /application\/json/);
  const m = JSON.parse(body);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.ok(m.size > 0);
  assert.equal(m.url, UI_OTA_BUNDLE_PATH);
});

test('ota: bundle with the token returns 200 application/zip', async () => {
  const inst = await bootWithSpa(makeSpaDir());
  const { statusCode, headers } = await req(
    portOf(inst), 'GET', UI_OTA_BUNDLE_PATH, { 'x-cortex-token': TOKEN },
  );
  assert.equal(statusCode, 200);
  assert.match(String(headers['content-type']), /application\/zip/);
});
