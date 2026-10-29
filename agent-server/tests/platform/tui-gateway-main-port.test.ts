import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { TuiGatewayAdapter } from '../../src/platform/adapters/tui/tui-gateway.js';
import { createMainHttpServer, type MainHttpServer } from '../../src/platform/main-http/main-server.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { conversationHistory } from '../../src/store/conversation-history-repo.js';
import { createTuiSessionService } from '../../src/domain/tui-session/index.js';
import { enqueue, conduitQueues } from '../../src/orchestration/conduit-queue.js';

const TOKEN = 'tui-main-port-token';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function gatewayOnMainPort(): Promise<{ adapter: TuiGatewayAdapter; port: number }> {
  const adapter = new TuiGatewayAdapter();
  adapter.setSessionService(createTuiSessionService({ sessionStore, conversationLedger, conversationHistory }));
  adapter.setConduitQueue({ enqueue, remove: (id) => conduitQueues.delete(id) });
  await adapter.start();
  const main: MainHttpServer = createMainHttpServer({ port: 0, host: '127.0.0.1', getClientToken: () => TOKEN });
  main.mountTui((req, socket, head) => adapter.handleUpgrade(req, socket, head));
  const port = await main.listen();
  cleanups.push(async () => { await adapter.stop(); await main.close(); });
  return { adapter, port };
}

function firstFrame(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('no frame')), 3000);
  });
}

test('without a port the gateway binds nothing and serves /tui through the main server', async () => {
  const { adapter, port } = await gatewayOnMainPort();
  assert.equal(typeof (adapter as any)._wss.address, 'function');
  assert.throws(() => (adapter as any)._wss.address(), /noServer/);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/tui`, { headers: { 'x-cortex-token': TOKEN } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const frame = firstFrame(ws);
  ws.send(JSON.stringify({ type: 'handshake.hello', protocolVersion: 1, clientName: 'test', clientVersion: '1.0', project: 'general', resume: null }));
  const ack = await frame;
  assert.equal(ack.type, 'handshake.ack');
  ws.close();
});

test('a /tui handshake without the token never reaches the gateway', async () => {
  const { port } = await gatewayOnMainPort();
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tui`);
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode ?? 0); });
    ws.once('error', () => resolve(0));
  });
  assert.equal(status, 401);
});
