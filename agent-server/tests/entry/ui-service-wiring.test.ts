import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildUiService } from '../../src/entry/ui-service-wiring.js';
import { runRegistry } from '../../src/core/run-registry.js';
import { EventBus } from '../../src/events/event-bus.js';

function service() {
  return buildUiService({
    adapter: {} as never,
    bus: new EventBus(),
    scheduler: {} as never,
    serverUpdateCoordinator: { check: async () => ({ status: 'error', reason: 'check_failed' }) },
  });
}

test('the wired executions.cancel kills the live process', async () => {
  let killed = 0;
  runRegistry.register({
    channel: 'web:wired', executionId: 'exec-wired', backend: 'claude',
    kill: () => { killed++; return true; },
  });
  const res = await service().mutate('executions.cancel', { executionId: 'exec-wired' });
  assert.deepEqual(res, { ok: true, data: { cancelled: true } });
  assert.equal(killed, 1);
  assert.equal(runRegistry.getById('exec-wired'), null);
});

test('the wired executions.cancel of an unknown execution is not-found', async () => {
  const res = await service().mutate('executions.cancel', { executionId: 'exec-ghost' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
});
