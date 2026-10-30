// Shutting down while Slack's socket-mode client is mid-reconnect must not leak an unhandled
// rejection: the reconnect's start() rejects with `undefined` when stop() lands before `hello`.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { LogLevel, SocketModeReceiver, type Logger } from '@slack/bolt';

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {},
};

interface FakeSlack {
  apiUrl: string;
  sockets: WebSocket[];
  waitForSocket(count: number): Promise<void>;
  close(): Promise<void>;
}

/** Serves apps.connections.open and the socket it points at. Only the first socket gets `hello`. */
async function startFakeSlack(): Promise<FakeSlack> {
  const server = http.createServer((_req, res) => {
    const { port } = server.address() as AddressInfo;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/socket` }));
  });
  const wss = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  const waiters: (() => void)[] = [];
  wss.on('connection', (socket) => {
    sockets.push(socket);
    if (sockets.length === 1) socket.send(JSON.stringify({ type: 'hello' }));
    waiters.splice(0).forEach((wake) => wake());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const waitForSocket = async (count: number) => {
    while (sockets.length < count) await new Promise<void>((wake) => waiters.push(wake));
  };
  const close = async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { apiUrl: `http://127.0.0.1:${port}/api/`, sockets, waitForSocket, close };
}

const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };
const cleanups: (() => Promise<unknown>)[] = [];

beforeEach(() => {
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  process.off('unhandledRejection', onRejection);
});

test('stopping during a pending reconnect leaks no unhandled rejection', async () => {
  const slack = await startFakeSlack();
  cleanups.push(slack.close);
  // The first reconnect waits clientPingTimeout ms; pongs from the local server arrive well within it.
  const receiver = new SocketModeReceiver({
    appToken: 'xapp-test',
    logger: silentLogger,
    clientPingTimeout: 200,
    installerOptions: { clientOptions: { slackApiUrl: slack.apiUrl } },
  });
  cleanups.push(() => receiver.stop());

  await receiver.start();
  slack.sockets[0].terminate();
  // The reconnect's start() has opened a new socket and now waits for a `hello` that never comes.
  await slack.waitForSocket(2);

  const disconnected = new Promise((resolve) => receiver.client.once('disconnected', resolve));
  await receiver.stop();
  await disconnected;
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(rejections).toEqual([]);
});
