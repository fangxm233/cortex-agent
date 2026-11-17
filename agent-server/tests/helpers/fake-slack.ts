// A local stand-in for Slack's socket-mode endpoints: `apps.connections.open` plus the socket it
// hands out, and `auth.test`. Each open or auth.test call follows the next scripted reply, so tests
// can drive a real Bolt socket-mode client through drops, missing `hello`s and API errors without
// the network.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { LogLevel, type Logger } from '@slack/bolt';

/** `hello`: a socket that is greeted. `silent`: a socket never greeted. `drop`: a socket the server
 *  cuts before greeting it. `invalid_auth`: an API error. `slow`: a greeted socket, answered late. */
export type OpenReply = 'hello' | 'silent' | 'drop' | 'invalid_auth' | 'slow';

export const SLOW_REPLY_MS = 50;

export interface FakeSlackStats {
  openCalls: number;
  authCalls: number;
  hellos: number;
  openSockets: number;
  maxOpenSockets: number;
}

export interface FakeSlack {
  apiUrl: string;
  /** Replies for the coming open calls; once it runs out, every call gets `hello`. */
  script: OpenReply[];
  /** Replies for the coming auth.test calls; once it runs out, every call succeeds. */
  authScript: 'invalid_auth'[];
  sockets: WebSocket[];
  stats: FakeSlackStats;
  close(): Promise<void>;
}

export const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {},
};

function sendJson(res: http.ServerResponse, body: object): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function answerOpen(fake: FakeSlack, res: http.ServerResponse, port: number): void {
  fake.stats.openCalls += 1;
  const reply = fake.script.shift() ?? 'hello';
  if (reply === 'invalid_auth') return sendJson(res, { ok: false, error: 'invalid_auth' });
  const body = { ok: true, url: `ws://127.0.0.1:${port}/socket?reply=${reply}` };
  if (reply === 'slow') setTimeout(() => sendJson(res, body), SLOW_REPLY_MS);
  else sendJson(res, body);
}

function acceptSocket(fake: FakeSlack, socket: WebSocket, url = ''): void {
  const { stats } = fake;
  fake.sockets.push(socket);
  stats.openSockets += 1;
  stats.maxOpenSockets = Math.max(stats.maxOpenSockets, stats.openSockets);
  socket.on('close', () => { stats.openSockets -= 1; });
  const reply = new URL(url, 'ws://local').searchParams.get('reply');
  if (reply === 'drop') return socket.terminate();
  if (reply === 'silent') return;
  stats.hellos += 1;
  socket.send(JSON.stringify({ type: 'hello' }));
}

export async function startFakeSlack(): Promise<FakeSlack> {
  const fake: FakeSlack = {
    apiUrl: '',
    script: [],
    authScript: [],
    sockets: [],
    stats: { openCalls: 0, authCalls: 0, hellos: 0, openSockets: 0, maxOpenSockets: 0 },
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    if (req.url?.endsWith('/apps.connections.open')) return answerOpen(fake, res, port);
    if (req.url?.endsWith('/auth.test')) {
      fake.stats.authCalls += 1;
      if (fake.authScript.shift()) return sendJson(res, { ok: false, error: 'invalid_auth' });
    }
    sendJson(res, { ok: true, user_id: 'U0BOT', bot_id: 'B0BOT' });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => acceptSocket(fake, socket, req.url));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  fake.close = async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}
