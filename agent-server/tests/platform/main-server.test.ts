import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';

vi.mock('@core/hook-bus.js', () => ({ emitCortexEvent: vi.fn().mockResolvedValue([]) }));

import { createMainHttpServer, isLocalRequest, type MainHttpServer } from '../../src/platform/main-http/main-server.js';
import { handleClientUpgrade, startClientManager, stopClientManager } from '../../src/domain/remote/client-manager.js';
import { _testSetRegistry } from '../../src/domain/remote/machine-registry.js';

const CLIENT_TOKEN = 'main-server-client-token';
process.env.CORTEX_CLIENT_TOKEN = CLIENT_TOKEN;

const servers: MainHttpServer[] = [];
afterEach(async () => {
  await stopClientManager();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(host = '127.0.0.1'): Promise<{ main: MainHttpServer; port: number }> {
  const main = createMainHttpServer({ port: 0, host, getClientToken: () => CLIENT_TOKEN });
  servers.push(main);
  const port = await main.listen();
  return { main, port };
}

function request(port: number, path: string, headers: Record<string, string> = {}, host = '127.0.0.1') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

/** Open a WebSocket; resolves with 'open' or the refused handshake's HTTP status. */
function upgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve({ status: res.statusCode }); });
    ws.once('error', () => resolve({ status: 0 }));
  });
}

function echoUpgrade(): (req: http.IncomingMessage, socket: any, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });
  return (req, socket, head) => wss.handleUpgrade(req, socket, head, () => {});
}

// ── Requests ──────────────────────────────────────────────────────────────────

test('webhook routes answer 503 until mounted, then reach the webhook handler', async () => {
  const { main, port } = await start();
  assert.equal((await request(port, '/webhook/devices')).status, 503);
  main.mountWebhook((_req, res) => { res.writeHead(200); res.end('hook'); });
  assert.deepEqual(await request(port, '/webhook/devices'), { status: 200, body: 'hook' });
  assert.deepEqual(await request(port, '/hook/ask-user-question'), { status: 200, body: 'hook' });
});

test('webhook routes refuse a request relayed by a proxy or tunnel', async () => {
  const { main, port } = await start();
  main.mountWebhook((_req, res) => { res.writeHead(200); res.end('hook'); });
  for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip']) {
    assert.equal((await request(port, '/webhook/signal', { [header]: '203.0.113.9' })).status, 403, header);
  }
});

test('webhook routes refuse a peer that is not loopback', async (t) => {
  const lan = Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal);
  if (!lan) { t.skip(); return; }
  const { main, port } = await start('0.0.0.0');
  main.mountWebhook((_req, res) => { res.writeHead(200); res.end('hook'); });
  assert.equal((await request(port, '/webhook/devices', {}, lan.address)).status, 403);
  assert.equal((await request(port, '/webhook/devices')).status, 200);
});

test('isLocalRequest: loopback peers only, IPv4, IPv6 and mapped', () => {
  const req = (remoteAddress: string, headers = {}) => ({ socket: { remoteAddress }, headers }) as unknown as http.IncomingMessage;
  for (const address of ['127.0.0.1', '127.8.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLocalRequest(req(address)), true, address);
  for (const address of ['10.0.0.5', '::ffff:10.0.0.5', '192.168.1.2']) assert.equal(isLocalRequest(req(address)), false, address);
  assert.equal(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false);
});

test('without a UI every other request is a 404; with one it reaches the UI', async () => {
  const { main, port } = await start();
  assert.equal((await request(port, '/trpc/system.status')).status, 404);
  main.mountUi({ handleRequest: (_req, res) => { res.writeHead(200); res.end('ui'); }, handleUpgrade: () => false, close: () => {} });
  assert.deepEqual(await request(port, '/trpc/system.status'), { status: 200, body: 'ui' });
  assert.deepEqual(await request(port, '/'), { status: 200, body: 'ui' });
});

// ── Upgrades ──────────────────────────────────────────────────────────────────

test('/tui requires the client token and refuses a foreign page', async () => {
  const { main, port } = await start();
  main.mountTui(echoUpgrade());
  assert.equal((await upgrade(port, '/tui')).status, 401);
  assert.equal((await upgrade(port, '/tui', { 'x-cortex-token': 'wrong' })).status, 401);
  const foreign = await upgrade(port, '/tui', { 'x-cortex-token': CLIENT_TOKEN, origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const ok = await upgrade(port, '/tui', { 'x-cortex-token': CLIENT_TOKEN });
  assert.ok(ok.ws);
  ok.ws!.close();
});

test('/tui is not served before the TUI gateway is mounted', async () => {
  const { port } = await start();
  assert.equal((await upgrade(port, '/tui', { 'x-cortex-token': CLIENT_TOKEN })).status, 404);
});

test('the UI keeps its own upgrade paths', async () => {
  const { main, port } = await start();
  const seen: string[] = [];
  const claim = echoUpgrade();
  main.mountUi({
    handleRequest: (_req, res) => res.end(),
    handleUpgrade: (req, socket, head) => {
      if (req.url !== '/forward') return false;
      seen.push(req.url);
      claim(req, socket, head);
      return true;
    },
    close: () => {},
  });
  main.mountClient(() => { throw new Error('client handler must not see /forward'); });
  const result = await upgrade(port, '/forward');
  assert.ok(result.ws);
  result.ws!.close();
  assert.deepEqual(seen, ['/forward']);
});

test('client upgrades are refused until the client hub is mounted', async () => {
  const { port } = await start();
  assert.equal((await upgrade(port, '/client', { 'x-cortex-token': CLIENT_TOKEN })).status, 503);
});

test('/client, the root path and any other path accept only the client token', async () => {
  _testSetRegistry({});
  const { main, port } = await start();
  startClientManager(port, undefined, { listen: false });
  main.mountClient(handleClientUpgrade);
  for (const path of ['/client', '/', '/anything']) {
    assert.equal((await upgrade(port, path)).status, 401, `${path} without a token`);
    assert.equal((await upgrade(port, path, { cookie: 'cortex_ui=session-id' })).status, 401, `${path} with a UI cookie`);
    assert.equal((await upgrade(port, path, { 'x-cortex-token': 'paired-app-token' })).status, 401, `${path} with another token`);
    const ok = await upgrade(port, path, { 'x-cortex-token': CLIENT_TOKEN });
    assert.ok(ok.ws, `${path} with the client token`);
    ok.ws!.close();
  }
});

test('/reverse at the root reaches the client hub\'s reverse-stream handling', async () => {
  _testSetRegistry({});
  const { main, port } = await start();
  startClientManager(port, undefined, { listen: false });
  main.mountClient(handleClientUpgrade);
  const { ws } = await upgrade(port, `/reverse?stream=${'a'.repeat(32)}`, { 'x-cortex-token': CLIENT_TOKEN });
  assert.ok(ws);
  const code = await new Promise<number>((resolve) => ws!.once('close', (c) => resolve(c)));
  assert.equal(code, 4004);
});

test('listen rejects with the bind error when the port is taken', async () => {
  const { port } = await start();
  const second = createMainHttpServer({ port, host: '127.0.0.1', getClientToken: () => CLIENT_TOKEN });
  await assert.rejects(second.listen(), (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE');
});
