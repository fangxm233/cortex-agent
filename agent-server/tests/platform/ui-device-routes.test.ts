import { describe, test, beforeEach, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTRPC } from '@trpc/server';
import { createUiHttpServer, createAuthorizer } from '@platform/ui-http/ui-http-server.js';
import {
  createUiAuthRoutes, UI_LOGIN_PATH, UI_SESSION_COOKIE, UI_SESSION_PATH,
} from '@platform/ui-http/ui-auth-routes.js';
import {
  createUiDeviceRoutes, UI_DEVICE_REVOKE_PATH, UI_DEVICES_PATH, UI_PAIR_PATH, UI_PAIRING_CODE_PATH,
} from '@platform/ui-http/ui-device-routes.js';
import { createUiDeviceStore } from '@platform/ui-http/ui-devices.js';
import { createPairingStore } from '@platform/ui-http/ui-pairing.js';
import { createUiSessionStore } from '@platform/ui-http/ui-session.js';

const TOKEN = 'master-client-token';
const t = initTRPC.create();
const fakeRouter = t.router({ ping: t.procedure.query(() => 'pong') });

const servers: Array<{ close: () => Promise<void> }> = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

interface Res { statusCode: number; body: any; headers: http.IncomingHttpHeaders }
function call(port: number, method: 'GET' | 'POST', urlPath: string, headers: Record<string, string> = {}, payload?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const r = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed: unknown = buf;
        try { parsed = JSON.parse(buf); } catch { /* plain text */ }
        resolve({ statusCode: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const auth = (token: string) => ({ 'x-cortex-token': token });

/** A WebSocket upgrade attempt on /forward. Resolves the status (101 = the forward opened). */
function upgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port, path: '/forward?port=5173',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'), ...headers,
      },
    });
    r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101); });
    r.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', () => resolve(0));
    r.end();
  });
}

/** Wired the way start-ui-http wires token login + pairing. */
async function boot(): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-device-routes-'));
  dirs.push(dir);
  const devices = createUiDeviceStore({ file: path.join(dir, 'ui-devices.json') });
  const pairing = createPairingStore({ file: path.join(dir, 'ui-pairing.json') });
  const store = createUiSessionStore();
  const getToken = () => TOKEN;
  const matchDeviceToken = (token: string | undefined) => devices.match(token) !== undefined;
  const authorize = createAuthorizer({ getToken, matchDeviceToken, verifySession: (sid) => store.verify(sid) });
  const inst = createUiHttpServer({
    router: fakeRouter, getToken, matchDeviceToken, port: 0, host: '127.0.0.1', authorize,
    publicRoutes: [UI_LOGIN_PATH, UI_SESSION_PATH, UI_PAIR_PATH],
    customRoutes: {
      ...createUiAuthRoutes({ store, getToken, authorize, ttlMs: 60_000, redeemCode: (c) => pairing.redeem(c) }),
      ...createUiDeviceRoutes({ devices, pairing }),
    },
  });
  servers.push(inst);
  await new Promise<void>((resolve) => (inst.server.listening ? resolve() : inst.server.once('listening', () => resolve())));
  const addr = inst.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no TCP address');
  return addr.port;
}

async function mintCode(port: number): Promise<string> {
  const res = await call(port, 'POST', UI_PAIRING_CODE_PATH, auth(TOKEN));
  assert.equal(res.statusCode, 200);
  return res.body.data.code;
}

describe('pairing an app', () => {
  let port: number;
  beforeEach(async () => { port = await boot(); });

  test('a code is minted only behind the gate', async () => {
    assert.equal((await call(port, 'POST', UI_PAIRING_CODE_PATH)).statusCode, 401);
    assert.match(await mintCode(port), /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  test('a code buys one device token that passes the gate until revoked', async () => {
    const code = await mintCode(port);
    const paired = await call(port, 'POST', UI_PAIR_PATH, {}, { code, name: 'Android' });
    assert.equal(paired.statusCode, 200);
    const token: string = paired.body.data.token;
    assert.equal((await call(port, 'GET', '/trpc/ping', auth(token))).statusCode, 200);

    const again = await call(port, 'POST', UI_PAIR_PATH, {}, { code, name: 'Second' });
    assert.equal(again.statusCode, 401);
    assert.equal(again.body.code, 'invalid-code');

    const list = await call(port, 'GET', UI_DEVICES_PATH, auth(token));
    assert.equal(list.body.data.pairing, true);
    assert.deepEqual(list.body.data.devices.map((d: any) => [d.name, d.current]), [['Android', true]]);
    const fromMaster = await call(port, 'GET', UI_DEVICES_PATH, auth(TOKEN));
    assert.equal(fromMaster.body.data.devices[0].current, false);

    const id = list.body.data.devices[0].id;
    assert.equal((await call(port, 'POST', UI_DEVICE_REVOKE_PATH, auth(TOKEN), { id })).statusCode, 200);
    assert.equal((await call(port, 'GET', '/trpc/ping', auth(token))).statusCode, 401);
    assert.equal((await call(port, 'POST', UI_DEVICE_REVOKE_PATH, auth(TOKEN), { id })).statusCode, 404);
  });

  test('a device token opens the port forward, as the client token does', async () => {
    const paired = await call(port, 'POST', UI_PAIR_PATH, {}, { code: await mintCode(port), name: 'Desktop' });
    assert.equal(await upgrade(port, auth(paired.body.data.token)), 101);
    assert.equal(await upgrade(port, auth('not-a-token')), 401);
  });

  test('a paired app can mint the next code', async () => {
    const paired = await call(port, 'POST', UI_PAIR_PATH, {}, { code: await mintCode(port), name: 'A' });
    const res = await call(port, 'POST', UI_PAIRING_CODE_PATH, auth(paired.body.data.token));
    assert.equal(res.statusCode, 200);
  });
});

describe('browser sign-in with a code', () => {
  let port: number;
  beforeEach(async () => { port = await boot(); });

  test('the login form accepts a code once and mints a session cookie', async () => {
    const code = await mintCode(port);
    const res = await call(port, 'POST', UI_LOGIN_PATH, {}, { token: code.toLowerCase() });
    assert.equal(res.statusCode, 200);
    const cookie = String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];
    assert.ok(cookie.startsWith(`${UI_SESSION_COOKIE}=`));
    assert.equal((await call(port, 'GET', '/trpc/ping', { Cookie: cookie })).statusCode, 200);
    assert.equal((await call(port, 'POST', UI_LOGIN_PATH, {}, { token: code })).statusCode, 401);
  });

  test('the client token still signs in', async () => {
    assert.equal((await call(port, 'POST', UI_LOGIN_PATH, {}, { token: TOKEN })).statusCode, 200);
  });
});
