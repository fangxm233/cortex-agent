import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { describe, test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { createUiHttpServer, createAuthorizer } from '@platform/ui-http/ui-http-server.js';
import {
  createUiAuthRoutes,
  createUiSessionProbeRoute,
  UI_LOGIN_PATH,
  UI_LOGOUT_PATH,
  UI_SESSION_PATH,
  UI_SESSION_COOKIE,
} from '@platform/ui-http/ui-auth-routes.js';
import { createUiSessionStore } from '@platform/ui-http/ui-session.js';

const TOKEN = 'test-ui-token-xyz';
const CUSTOM_PATH = '/api/test/echo';

const t = initTRPC.create();
const fakeRouter = t.router({
  ping: t.procedure.input(z.object({ v: z.string() })).query(({ input }) => ({ echoed: input.v })),
});

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
});

// ── HTTP helpers ──────────────────────────────────────────────────────────────
interface Res { statusCode: number; body: string; headers: http.IncomingHttpHeaders }
function req(
  port: number,
  method: 'GET' | 'POST',
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
const postJson = (port: number, urlPath: string, payload: unknown, headers: Record<string, string> = {}) =>
  req(port, 'POST', urlPath, { 'Content-Type': 'application/json', ...headers }, JSON.stringify(payload));

const pingPath = () => `/trpc/ping?input=${encodeURIComponent(JSON.stringify({ v: 'hi' }))}`;
const cookieHeader = (sid: string) => ({ Cookie: `${UI_SESSION_COOKIE}=${sid}` });

/** Pull the session id out of a Set-Cookie response header. */
function sidFromSetCookie(res: Res): string {
  const raw = res.headers['set-cookie'];
  assert.ok(raw && raw.length > 0, 'expected a Set-Cookie header');
  const m = new RegExp(`${UI_SESSION_COOKIE}=([^;]*)`).exec(raw[0]);
  assert.ok(m, 'expected the session cookie in Set-Cookie');
  return m[1];
}

/** A WebSocket upgrade attempt on /forward. Resolves the status (101 = the forward opened). */
function upgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      path: '/forward?port=5173',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101); });
    r.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', () => resolve(0));
    r.end();
    setTimeout(() => reject(new Error('upgrade timeout')), 4000).unref();
  });
}

/**
 * Boot a transport wired exactly the way start-ui-http wires it for token login: one memory-only
 * session store, one authorizer shared by the gate and the probe, login+probe public.
 */
async function bootWithTokenLogin(opts: { tokenLogin?: boolean } = {}) {
  const tokenLogin = opts.tokenLogin !== false;
  const store = tokenLogin ? createUiSessionStore() : undefined;
  const getToken = () => TOKEN;
  const verifySession = store ? (sid: string | undefined) => store.verify(sid) : undefined;
  const authorize = createAuthorizer({ getToken, verifySession });
  const inst = createUiHttpServer({
    router: fakeRouter,
    getToken,
    port: 0,
    host: '127.0.0.1',
    verifySession,
    authorize,
    publicRoutes: tokenLogin ? [UI_LOGIN_PATH, UI_SESSION_PATH] : [UI_SESSION_PATH],
    customRoutes: {
      [CUSTOM_PATH]: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      ...(store
        ? createUiAuthRoutes({ store, getToken, authorize, ttlMs: 60_000 })
        : createUiSessionProbeRoute(authorize)),
    },
  });
  servers.push(inst);
  await new Promise<void>((resolve, reject) => {
    if (inst.server.listening) return resolve();
    inst.server.once('listening', () => resolve());
    inst.server.once('error', reject);
  });
  const addr = inst.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no TCP address');
  return { port: addr.port, store };
}

describe('token login: minting a browser session', () => {
  let port: number;
  beforeAll(async () => { ({ port } = await bootWithTokenLogin()); });

  test('the login route is reachable without any credential', async () => {
    // A browser that holds nothing must be able to knock — otherwise there is no way in at all.
    const { statusCode } = await postJson(port, UI_LOGIN_PATH, { token: 'wrong' });
    assert.equal(statusCode, 401, 'wrong token is rejected, but the route itself answered');
  });

  test('a wrong token is refused, slowly, and mints nothing', async () => {
    const t0 = Date.now();
    const res = await postJson(port, UI_LOGIN_PATH, { token: 'wrong' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.ok(Date.now() - t0 >= 200, 'a failed login must be delayed, not instant');
  });

  test('an empty token never matches (an unset server token must not admit an empty string)', async () => {
    const res = await postJson(port, UI_LOGIN_PATH, { token: '' });
    assert.equal(res.statusCode, 401);
  });

  test('the right token returns an HttpOnly, SameSite=Strict session cookie', async () => {
    const res = await postJson(port, UI_LOGIN_PATH, { token: TOKEN });
    assert.equal(res.statusCode, 200);
    const setCookie = res.headers['set-cookie']![0];
    assert.match(setCookie, /HttpOnly/, 'the page must never be able to read the session');
    assert.match(setCookie, /SameSite=Strict/, 'no cross-site request may carry it');
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Max-Age=60/);
    // 127.0.0.1 is a trustworthy origin, so Secure is set even over plain http here.
    assert.match(setCookie, /Secure/);
    assert.match(sidFromSetCookie(res), /^[0-9a-f]{64}$/);
  });

  test('GET on the login route is refused (it is a credential POST)', async () => {
    const { statusCode } = await get(port, UI_LOGIN_PATH);
    assert.equal(statusCode, 405);
  });

  test('a cross-origin login attempt is refused before the token is even compared', async () => {
    const res = await postJson(port, UI_LOGIN_PATH, { token: TOKEN }, { Origin: 'https://evil.example.com' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('a same-origin login (Origin matches Host) is accepted', async () => {
    const res = await postJson(
      port,
      UI_LOGIN_PATH,
      { token: TOKEN },
      { Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` },
    );
    assert.equal(res.statusCode, 200);
  });

  test('an oversized body is rejected rather than buffered', async () => {
    const res = await postJson(port, UI_LOGIN_PATH, { token: 'x'.repeat(9000) });
    assert.equal(res.statusCode, 400);
  });
});

describe('token login: what a session cookie may do', () => {
  let port: number;
  let sid: string;
  beforeAll(async () => {
    ({ port } = await bootWithTokenLogin());
    sid = sidFromSetCookie(await postJson(port, UI_LOGIN_PATH, { token: TOKEN }));
  });

  test('it passes the tRPC gate', async () => {
    const { statusCode, body } = await get(port, pingPath(), cookieHeader(sid));
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(body).result.data, { echoed: 'hi' });
  });

  test('it passes a custom /api route (uploads, downloads, media all ride this)', async () => {
    const { statusCode } = await get(port, CUSTOM_PATH, cookieHeader(sid));
    assert.equal(statusCode, 200);
  });

  test('it does NOT open the /forward raw TCP tunnel — the one thing a browser must never get', async () => {
    // A browser attaches this cookie to a WebSocket handshake automatically, so the upgrade path
    // has to stay token-only. If this ever returns 101, every logged-in page owns every loopback
    // service on the host.
    const status = await upgrade(port, cookieHeader(sid));
    assert.notEqual(status, 101);
  });

  test('the token still opens /forward (the native client path is untouched)', async () => {
    const status = await upgrade(port, { 'x-cortex-token': TOKEN });
    assert.equal(status, 101);
  });

  test('a forged / unknown session id is refused', async () => {
    const { statusCode } = await get(port, pingPath(), cookieHeader('0'.repeat(64)));
    assert.equal(statusCode, 401);
  });

  test('no credential at all is still a 401', async () => {
    const { statusCode } = await get(port, pingPath());
    assert.equal(statusCode, 401);
  });

  test('the token header keeps working alongside the cookie leg', async () => {
    const { statusCode } = await get(port, pingPath(), { 'x-cortex-token': TOKEN });
    assert.equal(statusCode, 200);
  });
});

describe('token login: the probe and logout', () => {
  let port: number;
  beforeAll(async () => { ({ port } = await bootWithTokenLogin()); });

  test('the probe answers without a credential and reports "not in, form available"', async () => {
    const { statusCode, body } = await get(port, UI_SESSION_PATH);
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(body).data, { authenticated: false, tokenLogin: true });
  });

  test('the probe reports authenticated once a session exists', async () => {
    const sid = sidFromSetCookie(await postJson(port, UI_LOGIN_PATH, { token: TOKEN }));
    const { body } = await get(port, UI_SESSION_PATH, cookieHeader(sid));
    assert.equal(JSON.parse(body).data.authenticated, true);
  });

  test('logout revokes that session and clears the cookie', async () => {
    const sid = sidFromSetCookie(await postJson(port, UI_LOGIN_PATH, { token: TOKEN }));
    const out = await postJson(port, UI_LOGOUT_PATH, {}, cookieHeader(sid));
    assert.equal(out.statusCode, 200);
    assert.match(out.headers['set-cookie']![0], /Max-Age=0/);
    assert.equal((await get(port, pingPath(), cookieHeader(sid))).statusCode, 401);
  });

  test('logout itself needs a credential (it is not a public route)', async () => {
    const { statusCode } = await postJson(port, UI_LOGOUT_PATH, {});
    assert.equal(statusCode, 401);
  });

  test('one browser logging out does not evict the others', async () => {
    const a = sidFromSetCookie(await postJson(port, UI_LOGIN_PATH, { token: TOKEN }));
    const b = sidFromSetCookie(await postJson(port, UI_LOGIN_PATH, { token: TOKEN }));
    await postJson(port, UI_LOGOUT_PATH, {}, cookieHeader(a));
    assert.equal((await get(port, pingPath(), cookieHeader(b))).statusCode, 200);
  });
});

describe('token login switched off (CORTEX_UI_TOKEN_LOGIN=0)', () => {
  let port: number;
  beforeAll(async () => { ({ port } = await bootWithTokenLogin({ tokenLogin: false })); });

  test('the login route is gone', async () => {
    // Not registered → it is no longer a custom route, so it falls through to the SPA handler
    // (404 here, since no SPA dir is configured) rather than answering as an endpoint.
    const { statusCode } = await postJson(port, UI_LOGIN_PATH, { token: TOKEN });
    assert.equal(statusCode, 404);
  });

  test('the probe still answers, and says there is no form to show', async () => {
    const { body } = await get(port, UI_SESSION_PATH);
    assert.deepEqual(JSON.parse(body).data, { authenticated: false, tokenLogin: false });
  });

  test('a cookie cannot admit anything', async () => {
    const { statusCode } = await get(port, pingPath(), cookieHeader('0'.repeat(64)));
    assert.equal(statusCode, 401);
  });

  test('the token path is unchanged', async () => {
    assert.equal((await get(port, pingPath(), { 'x-cortex-token': TOKEN })).statusCode, 200);
  });
});
