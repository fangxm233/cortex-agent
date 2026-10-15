import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runShutdown, shutdownSteps, type ShutdownHandles } from '../../src/entry/shutdown.js';
import { registerFlushable } from '../../src/core/json-repository.js';

function handles(calls: string[]): ShutdownHandles {
  return {
    bus: { close: () => { calls.push('bus.close'); } },
    outboundQueue: { stop: async () => { calls.push('oq.stop'); }, flush: async () => { calls.push('oq.flush'); } },
    scheduler: { stop: () => { calls.push('scheduler.stop'); } },
    retention: { stop: async () => { calls.push('retention.stop'); } },
  };
}

test('runShutdown runs every step in order, past a failing one', async () => {
  const ran: string[] = [];
  await runShutdown([
    { name: 'a', run: () => { ran.push('a'); } },
    { name: 'b', run: async () => { ran.push('b'); throw new Error('boom'); } },
    { name: 'c', run: () => { ran.push('c'); } },
  ]);
  assert.deepEqual(ran, ['a', 'b', 'c']);
});

test('timers and the outbound loop stop before the stores drain; the gateway goes last', () => {
  const names = shutdownSteps(handles([])).map((step) => step.name);
  const flush = names.indexOf('flush stores');
  for (const before of ['scheduler', 'waitpoint sweep', 'outbound drain loop', 'platforms', 'web ui']) {
    assert.ok(names.indexOf(before) >= 0 && names.indexOf(before) < flush, `${before} precedes the drain`);
  }
  assert.equal(names[0], 'announce');
  assert.equal(names.at(-1), 'gateway');
});

test('shutdown stops the models watcher before draining stores', async () => {
  let stopped = false;
  const steps = shutdownSteps({ ...handles([]), stopModelsWatcher: () => { stopped = true; } });
  const index = steps.findIndex(step => step.name === 'models watcher');
  assert.ok(index >= 0 && index < steps.findIndex(step => step.name === 'flush stores'));
  await steps[index].run();
  assert.equal(stopped, true);
});

test('the drain step closes the bus, flushes the outbound queue and every registered store', async () => {
  const calls: string[] = [];
  registerFlushable({ flush: async () => { calls.push('store.flush'); } });
  const drain = shutdownSteps(handles(calls)).find((step) => step.name === 'flush stores')!;
  await drain.run();
  assert.deepEqual(calls.sort(), ['bus.close', 'oq.flush', 'store.flush']);
});
