import { after, before, beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

let socket: FakeSocket;
const exits: number[] = [];
const delays: number[] = [];
const exited = new Error('process exited');
const originalEnv = process.env;
const signals = new Map(['SIGINT', 'SIGTERM'].map(s => [s, process.listeners(s)]));

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: any[] = [];
  constructor() { super(); socket = this; }
  send(frame: string): void { this.sent.push(JSON.parse(frame)); }
}

before(async () => {
  mock.module('ws', { defaultExport: FakeSocket });
  mock.module('../../src/log.ts', {
    namedExports: { createLogger: () => ({ info() {}, warn() {}, error() {} }) },
  });
  mock.module('../../src/gpu-detect.ts', { namedExports: { detectGpuCount: () => null } });
  const readFile = fs.readFileSync;
  mock.method(fs, 'readFileSync', (file: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (String(file).endsWith('cortex-client.json')) return JSON.stringify({
      serverUrl: 'ws://fixture.invalid', deviceName: 'registered-local', clientToken: 'fixture',
    });
    return (readFile as any)(file, ...args);
  });
  syncBuiltinESMExports();
  process.env = { CORTEX_HOME: '/unused-reconnect-fixture', CORTEX_CLIENT_HOST: 'localhost' };
  await import('../../src/client.js');
});

beforeEach(t => {
  exits.length = 0;
  delays.length = 0;
  t.mock.method(process, 'exit', (code: number) => { exits.push(code); throw exited; });
  t.mock.method(globalThis, 'setTimeout', (_callback: unknown, delay: number) => { delays.push(delay); });
});

after(() => {
  process.env = originalEnv;
  for (const [signal, prior] of signals) {
    for (const listener of process.listeners(signal)) {
      if (!prior.includes(listener)) process.removeListener(signal, listener);
    }
  }
  mock.restoreAll();
  syncBuiltinESMExports();
});

for (const code of [4002, 4005]) {
  it(`exits on terminal rejection ${code} without scheduling a reconnect`, () => {
    assert.throws(() => socket.emit('close', code, Buffer.from('rejected')), error => error === exited);
    assert.deepEqual(exits, [1]);
    assert.deepEqual(delays, []);
  });
}

for (const code of [1001, 1006, 4003]) {
  it(`continues retrying transient close ${code}`, () => {
    socket.emit('close', code, Buffer.from('transient'));
    assert.deepEqual(exits, []);
    assert.deepEqual(delays, [1000]);
  });
}
