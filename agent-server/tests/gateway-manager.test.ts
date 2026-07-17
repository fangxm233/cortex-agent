// input:  Node test runner + module-loader + mocked http/cp
// output: gateway port-conflict handling tests
// pos:    Verify gateway reuses port on contention instead of spawning
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

async function importGatewayManagerWithMocks({ statusCode = 200 } = {}) {
  let spawnCalls = 0;

  const httpMock = {
    get(_url, options, callback) {
      const req = new EventEmitter() as EventEmitter & { destroy: () => void };
      req.destroy = () => {};

      process.nextTick(() => {
        const res = new EventEmitter() as EventEmitter & { statusCode?: number };
        res.statusCode = statusCode;
        callback(res);
        res.emit('data', Buffer.from('{"ok":true}'));
        res.emit('end');
      });

      return req;
    },
  };

  const childProcessMock = {
    spawn() {
      spawnCalls += 1;
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => boolean;
      };
      child.pid = 4321;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      return child;
    },
  };

  const originalGet = (globalThis as any).__mockHttpGet;
  const originalSpawn = (globalThis as any).__mockChildProcessSpawn;
  (globalThis as any).__mockHttpGet = httpMock.get;
  (globalThis as any).__mockChildProcessSpawn = childProcessMock.spawn;

  const gatewayManager = await import('./../src/domain/costs/gateway-manager.js?gateway-test=' + Date.now() + '-' + Math.random().toString(16).slice(2));

  return {
    gatewayManager,
    getSpawnCalls: () => spawnCalls,
    restore() {
      (globalThis as any).__mockHttpGet = originalGet;
      (globalThis as any).__mockChildProcessSpawn = originalSpawn;
    },
  };
}

test('startGateway reuses existing healthy gateway on occupied port without spawning child', async (t) => {
  const mocked = await importGatewayManagerWithMocks({ statusCode: 200 });
  const { gatewayManager } = mocked;

  t.onTestFinished(async () => {
    await gatewayManager.stopGateway();
    mocked.restore();
  });

  await gatewayManager.startGateway();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(gatewayManager.isGatewayHealthy(), true,
    'existing healthy gateway should be treated as healthy');
  assert.equal(mocked.getSpawnCalls(), 0,
    'manager should not spawn a child when a healthy gateway already occupies the port');
});
