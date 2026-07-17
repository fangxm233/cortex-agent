// input:  Node test runner + createUiHttpServer (transport-host) + a FAKE tRPC router
// output: integration tests — 401 gate, HTTP query roundtrip, SSE subscription event,
//         127.0.0.1 bind, SPA static stub (present/absent/traversal/malformed-URL), clean close(),
//         CORS allow-list (task 1b60): allowed origin gets ACAO header, non-wildcard, preflight 204,
//         401 response still carries CORS so the browser can read the error body.
// pos:    Regression guard for the Web UI tRPC HTTP+SSE transport-host (task d7c2, edf0/B, 1b60).
//         Generic over AnyRouter — builds its own tiny router, no dependency on the real AppRouter.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { createUiHttpServer } from '@platform/ui-http/ui-http-server.js';

const TOKEN = 'test-ui-token-xyz';
const INDEX_MARKER = '<!-- CORTEX-UI-STUB-INDEX -->';
const SSE_MARKER = 'EVENT_ONE_MARKER';

// ── Fake router (built off @trpc/server directly — no real AppRouter dependency) ──
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

const servers: Array<{ close: () => Promise<void> }> = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function boot(opts: { spaDir?: string; getToken?: () => string; corsOrigins?: string[] } = {}) {
  const inst = createUiHttpServer({
    router: fakeRouter,
    getToken: opts.getToken ?? (() => TOKEN),
    port: 0,
    host: '127.0.0.1',
    spaDir: opts.spaDir,
    corsOrigins: opts.corsOrigins,
  });
  servers.push(inst);
  if (!inst.server.listening) {
    await new Promise<void>((resolve, reject) => {
      inst.server.once('listening', () => resolve());
      inst.server.once('error', reject);
    });
  }
  const addr = inst.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no TCP address');
  return { inst, port: addr.port, host: addr.address };
}

interface Res { statusCode: number; body: string; headers: http.IncomingHttpHeaders }
function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

function options(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'OPTIONS', host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function encInput(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

test('bind: server listens on 127.0.0.1', async () => {
  const { host } = await boot();
  assert.equal(host, '127.0.0.1');
});

test('auth: tRPC request without a token is rejected 401', async () => {
  const { port } = await boot();
  const { statusCode } = await get(port, `/trpc/ping?input=${encInput({ v: 'hi' })}`);
  assert.equal(statusCode, 401);
});

test('auth: tRPC request with a wrong token is rejected 401', async () => {
  const { port } = await boot();
  const { statusCode } = await get(port, `/trpc/ping?input=${encInput({ v: 'hi' })}`, { 'x-cortex-token': 'nope' });
  assert.equal(statusCode, 401);
});

test('query: HTTP query roundtrip with the correct token returns 200 + data', async () => {
  const { port } = await boot();
  const { statusCode, body } = await get(port, `/trpc/ping?input=${encInput({ v: 'hello' })}`, { 'x-cortex-token': TOKEN });
  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.result.data, { echoed: 'hello' });
});

test('subscription: SSE receives one event', async () => {
  const { port } = await boot();
  const received = await new Promise<string>((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/trpc/tick', headers: { 'x-cortex-token': TOKEN, Accept: 'text/event-stream' } },
      (res) => {
        assert.equal(res.statusCode, 200);
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.includes(SSE_MARKER)) { req.destroy(); resolve(buf); }
        });
        res.on('error', () => { /* destroyed by us */ });
      },
    );
    req.on('error', (e) => { if (!String(e).includes('aborted')) reject(e); });
    setTimeout(() => reject(new Error('SSE timeout — no event received')), 5000).unref();
  });
  assert.ok(received.includes(SSE_MARKER));
});

test('static stub: spaDir present serves index.html', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-spa-'));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, 'index.html'), `<html><body>${INDEX_MARKER}</body></html>`);
  const { port } = await boot({ spaDir: dir });
  const { statusCode, body } = await get(port, '/');
  assert.equal(statusCode, 200);
  assert.ok(body.includes(INDEX_MARKER));
});

test('static stub: spaDir absent returns 404 placeholder', async () => {
  const { port } = await boot({ spaDir: undefined });
  const { statusCode } = await get(port, '/');
  assert.equal(statusCode, 404);
});

test('static stub: path traversal is rejected', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-spa-'));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, 'index.html'), `<html>${INDEX_MARKER}</html>`);
  const { port } = await boot({ spaDir: dir });
  const { statusCode } = await get(port, '/../../etc/passwd');
  assert.ok(statusCode === 403 || statusCode === 404, `expected 403/404, got ${statusCode}`);
});

test('static stub: a malformed percent-encoded URL is rejected 400 (no crash)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-spa-'));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, 'index.html'), `<html>${INDEX_MARKER}</html>`);
  const { port } = await boot({ spaDir: dir });
  // `%FF` is invalid UTF-8 percent-encoding → decodeURIComponent throws URIError.
  const { statusCode } = await get(port, '/%FF');
  assert.equal(statusCode, 400);
  // Server survived — a well-formed follow-up still works.
  const ok = await get(port, '/');
  assert.equal(ok.statusCode, 200);
});

test('close: shuts down cleanly (subsequent request refused)', async () => {
  const { inst, port } = await boot();
  await inst.close();
  await assert.rejects(get(port, `/trpc/ping?input=${encInput({ v: 'x' })}`, { 'x-cortex-token': TOKEN }));
});

// ── CORS allow-list tests (task 1b60) ────────────────────────────────────────
const ALLOWED_ORIGIN = 'tauri://localhost';
const BLOCKED_ORIGIN = 'https://evil.example.com';

test('cors: allowed origin gets Access-Control-Allow-Origin on tRPC query response', async () => {
  const { port } = await boot({ corsOrigins: [ALLOWED_ORIGIN] });
  const { headers } = await get(
    port,
    `/trpc/ping?input=${encInput({ v: 'hi' })}`,
    { 'x-cortex-token': TOKEN, 'origin': ALLOWED_ORIGIN },
  );
  assert.equal(headers['access-control-allow-origin'], ALLOWED_ORIGIN,
    'ACAO header must be the exact allowed origin');
});

test('cors: ACAO is not a wildcard — exact origin, not *', async () => {
  const { port } = await boot({ corsOrigins: [ALLOWED_ORIGIN] });
  const { headers } = await get(
    port,
    `/trpc/ping?input=${encInput({ v: 'hi' })}`,
    { 'x-cortex-token': TOKEN, 'origin': ALLOWED_ORIGIN },
  );
  assert.notEqual(headers['access-control-allow-origin'], '*', 'ACAO must not be wildcard');
});

test('cors: disallowed origin does NOT get ACAO header', async () => {
  const { port } = await boot({ corsOrigins: [ALLOWED_ORIGIN] });
  const { headers } = await get(
    port,
    `/trpc/ping?input=${encInput({ v: 'hi' })}`,
    { 'x-cortex-token': TOKEN, 'origin': BLOCKED_ORIGIN },
  );
  assert.equal(headers['access-control-allow-origin'], undefined,
    'Disallowed origin must not receive ACAO');
});

test('cors: no corsOrigins configured → no CORS headers (backward-compat)', async () => {
  const { port } = await boot();  // no corsOrigins
  const { headers } = await get(
    port,
    `/trpc/ping?input=${encInput({ v: 'hi' })}`,
    { 'x-cortex-token': TOKEN, 'origin': ALLOWED_ORIGIN },
  );
  assert.equal(headers['access-control-allow-origin'], undefined,
    'No CORS config → no ACAO header');
});

test('cors: OPTIONS preflight returns 204 with CORS headers (no auth token required)', async () => {
  const { port } = await boot({ corsOrigins: [ALLOWED_ORIGIN] });
  // No x-cortex-token — browser sends preflight BEFORE the actual request with headers
  const { statusCode, headers } = await options(
    port,
    '/trpc/ping',
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
  const { port } = await boot({ corsOrigins: [ALLOWED_ORIGIN] });
  const { statusCode, headers } = await get(
    port,
    `/trpc/ping?input=${encInput({ v: 'hi' })}`,
    { 'x-cortex-token': 'wrong-token', 'origin': ALLOWED_ORIGIN },
  );
  assert.equal(statusCode, 401);
  assert.equal(headers['access-control-allow-origin'], ALLOWED_ORIGIN,
    '401 responses must still carry ACAO so the browser can read the error body');
});
