import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FeishuAdapter } from '../../src/platform/adapters/feishu.js';

// The adapter loads the Lark SDK through createRequire, so patching the shared CJS export here
// swaps the WSClient it constructs in start().
const lark = createRequire(import.meta.url)('@larksuiteoapi/node-sdk');
const RealWSClient = lark.WSClient;

class FakeWSClient {
  static instances: FakeWSClient[] = [];
  static nextState = 'connecting';
  closed = 0;
  constructor(readonly params: { onReady?: () => void; onError?: (error: Error) => void }) {
    FakeWSClient.instances.push(this);
  }
  async start(): Promise<void> {}
  close(): void { this.closed += 1; }
  getConnectionStatus() { return { state: FakeWSClient.nextState, reconnectAttempts: 0 }; }
  ready(): void { this.params.onReady?.(); }
  fail(message: string): void { this.params.onError?.(new Error(message)); }
}

lark.WSClient = FakeWSClient;
afterEach(() => {
  FakeWSClient.instances = [];
  FakeWSClient.nextState = 'connecting';
});
process.on('exit', () => { lark.WSClient = RealWSClient; });

function makeAdapter(): FeishuAdapter {
  return new FeishuAdapter({ appId: 'cli_0123456789abcdef', appSecret: 'secret' });
}

async function lastClient(): Promise<FakeWSClient> {
  while (FakeWSClient.instances.length === 0) await new Promise((resolve) => setImmediate(resolve));
  return FakeWSClient.instances[FakeWSClient.instances.length - 1];
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([promise.catch(() => undefined), new Promise((resolve) => setImmediate(() => resolve(marker)))]);
  return winner === marker;
}

test('start() waits for the first handshake instead of returning once the SDK begins connecting', async () => {
  const adapter = makeAdapter();
  const starting = adapter.start();
  const client = await lastClient();
  assert.equal(await isPending(starting), true);

  client.ready();
  await starting;
  assert.equal(client.closed, 0);
});

test('start() rejects when the SDK gives up on the first connect, and releases the client', async () => {
  const adapter = makeAdapter();
  const starting = adapter.start();
  const client = await lastClient();

  client.fail('pullConnectConfig failed: code=10003, msg=invalid app');
  await assert.rejects(starting, /invalid app/);
  assert.equal(client.closed, 1);
});

test('start() rejects at once when the SDK silently declines to connect', async () => {
  FakeWSClient.nextState = 'idle';
  const adapter = makeAdapter();
  await assert.rejects(adapter.start(), /did not start/);
  assert.equal(FakeWSClient.instances[0].closed, 1);
});

test('stop() during the handshake rejects start() and drops a connection that completes afterwards', async () => {
  const adapter = makeAdapter();
  const starting = adapter.start();
  const client = await lastClient();

  await adapter.stop();
  await assert.rejects(starting, /stopped/);
  assert.equal(client.closed, 1);

  client.ready();
  assert.equal(client.closed, 2);
});

test('a give-up after the connection was up closes the client without throwing', async () => {
  const adapter = makeAdapter();
  const starting = adapter.start();
  const client = await lastClient();
  client.ready();
  await starting;

  client.fail('WebSocket reconnect exhausted after 3 attempts');
  assert.equal(client.closed, 1);
  await adapter.stop();
  assert.equal(client.closed, 1);
});
