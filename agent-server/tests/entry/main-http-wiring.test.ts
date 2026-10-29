import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { WebSocket } from 'ws';

vi.mock('@core/hook-bus.js', () => ({ emitCortexEvent: vi.fn().mockResolvedValue([]) }));

import { createMainServer, listenOrExit, startClientHub } from '../../src/entry/main-http-wiring.js';
import { APP_STOP_FILE, EXIT_PORT_UNAVAILABLE, clearAppStop, readAppStop } from '../../src/core/app-stop.js';
import { getClientManagerPort, stopClientManager } from '../../src/domain/remote/client-manager.js';

process.env.CORTEX_CLIENT_TOKEN = 'wiring-token';
const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await stopClientManager();
  clearAppStop();
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function occupy(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as net.AddressInfo).port;
}

test('the resolved port is published to the env children inherit', async () => {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { CORTEX_UI_PORT: String(port) };
  const main = createMainServer(env);
  assert.equal(main.port, port);
  assert.equal(main.host, '127.0.0.1');
  assert.equal(env.CORTEX_UI_PORT, String(port));
  assert.equal(createMainServer({ CORTEX_UI_PORT: String(port), CORTEX_UI_HOST: '0.0.0.0' }).host, '0.0.0.0');
});

test('a taken main port exits with EXIT_PORT_UNAVAILABLE and records why', async () => {
  const port = await occupy();
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as any);
  const main = createMainServer({ CORTEX_UI_PORT: String(port) });
  await assert.rejects(listenOrExit(main), new RegExp(`exit ${EXIT_PORT_UNAVAILABLE}`));
  assert.equal(exit.mock.calls[0][0], 78);
  const record = readAppStop(APP_STOP_FILE);
  assert.equal(record?.reason, 'port-in-use');
  assert.equal(record?.port, port);
  assert.match(record!.message, new RegExp(`Port ${port} is already in use.*CORTEX_UI_PORT`));
});

test('without CORTEX_CLIENT_PORT clients use the main port only', async () => {
  const main = createMainServer({ CORTEX_UI_PORT: String(await freePort()) });
  closers.push(() => main.server.close());
  await listenOrExit(main);
  startClientHub(main, {});
  assert.equal(getClientManagerPort(), main.port);
  const ws = new WebSocket(`ws://127.0.0.1:${main.port}/client`, { headers: { 'x-cortex-token': 'wiring-token' } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.close();
});

test('CORTEX_CLIENT_PORT keeps a legacy listener there, and local clients dial it', async () => {
  const main = createMainServer({ CORTEX_UI_PORT: String(await freePort()) });
  closers.push(() => main.server.close());
  await listenOrExit(main);
  const legacy = await freePort();
  startClientHub(main, { CORTEX_CLIENT_PORT: String(legacy), CORTEX_CLIENT_HOST: '127.0.0.1' });
  assert.equal(getClientManagerPort(), legacy);
  for (const port of [legacy, main.port]) {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const attempt = (): void => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-cortex-token': 'wiring-token' } });
        socket.once('open', () => resolve(socket));
        socket.once('error', (e) => (port === legacy ? setTimeout(attempt, 20) : reject(e)));
      };
      attempt();
    });
    ws.close();
  }
});
