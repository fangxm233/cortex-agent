import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as executionRegistry from '../../src/domain/executions/registry.js';
import { teardownExecution } from '../../src/domain/executions/registry.js';
import { runRegistry } from '../../src/core/run-registry.js';
import { EventBus } from '../../src/events/index.js';
import type { CortexEvent } from '../../src/events/index.js';

function register(executionId: string, bus: EventBus): void {
  runRegistry.setBus(bus);
  runRegistry.register({
    channel: 'C-teardown',
    executionId, kind: 'local', kill: () => true, backend: 'test',
  });
}

test('teardownExecution(completed) finalizes the persistent record AND publishes agent.completed', () => {
  const bus = new EventBus();
  const rec = executionRegistry.startLocalExecution({ channel: 'C-teardown', project: 'general', trigger: 'thread-step', backend: 'test' });
  register(rec.id, bus);

  const events: CortexEvent[] = [];
  bus.subscribe('*', (e) => { events.push(e); });

  teardownExecution({ executionId: rec.id, status: 'completed', durationS: 1, result: { total_cost_usd: 0.5 } as any });

  // Persistent ledger closed
  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'completed');
  // In-memory registry closed
  assert.equal(runRegistry.hasId(rec.id), false);
  // Balanced event published (this is what thread steps were missing)
  const completed = events.filter((e) => e.type === 'agent.completed');
  assert.equal(completed.length, 1);
  if (completed[0].type === 'agent.completed') assert.equal(completed[0].executionId, rec.id);
});

test('teardownExecution(failed) finalizes record AND publishes agent.failed', () => {
  const bus = new EventBus();
  const rec = executionRegistry.startLocalExecution({ channel: 'C-teardown', project: 'general', trigger: 'thread-step', backend: 'test' });
  register(rec.id, bus);

  const events: CortexEvent[] = [];
  bus.subscribe('*', (e) => { events.push(e); });

  teardownExecution({ executionId: rec.id, status: 'failed', durationS: 1, error: { message: 'boom' } });

  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'failed');
  assert.equal(runRegistry.hasId(rec.id), false);
  assert.equal(events.filter((e) => e.type === 'agent.failed').length, 1);
});

test('teardownExecution is idempotent — second call does not re-finalize or double-publish', () => {
  const bus = new EventBus();
  const rec = executionRegistry.startLocalExecution({ channel: 'C-teardown', project: 'general', trigger: 'thread-step', backend: 'test' });
  register(rec.id, bus);

  teardownExecution({ executionId: rec.id, status: 'completed', durationS: 1, result: { total_cost_usd: 0.5 } as any });

  const events: CortexEvent[] = [];
  bus.subscribe('*', (e) => { events.push(e); });
  // Second teardown (e.g. a later handler) must be a no-op on both ledgers.
  teardownExecution({ executionId: rec.id, status: 'failed', durationS: 1, error: { message: 'late' } });

  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'completed', 'terminal record must not flip to failed');
  assert.equal(events.length, 0, 'no event on the second teardown');
});

test('teardownExecution(cancelled) sets record cancelled, kills the handle, and publishes a balanced event', () => {
  const bus = new EventBus();
  const rec = executionRegistry.startLocalExecution({ channel: 'C-teardown', project: 'general', trigger: 'user', backend: 'test' });
  let killed = false;
  runRegistry.setBus(bus);
  runRegistry.register({ channel: 'C-teardown', executionId: rec.id, kind: 'local', kill: () => { killed = true; return true; }, backend: 'test' });

  const events: CortexEvent[] = [];
  bus.subscribe('*', (e) => { events.push(e); });

  teardownExecution({ executionId: rec.id, status: 'cancelled', durationS: 1 });

  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'cancelled');
  assert.equal(killed, true, 'cancelled teardown must kill the live handle');
  assert.equal(runRegistry.hasId(rec.id), false);
  // A balanced terminal event is published (agent.started is no longer dangling on cancel).
  assert.equal(events.filter((e) => e.type === 'agent.superseded').length, 1);
});

test('teardownExecution(null executionId) is a safe no-op', () => {
  assert.doesNotThrow(() => teardownExecution({ executionId: null, status: 'completed', durationS: 0 }));
});

// A run that ends cancelled, failed or rate-limited has still spent what it spent: the session
// totals read these metrics, so dropping them showed a stopped turn as $0.
for (const status of ['cancelled', 'failed', 'rate-limited'] as const) {
  test(`teardownExecution(${status}) keeps the cost and turns the run reported`, () => {
    const bus = new EventBus();
    const rec = executionRegistry.startLocalExecution({ channel: 'C-teardown', project: 'general', trigger: 'user', backend: 'test' });
    register(rec.id, bus);

    teardownExecution({
      executionId: rec.id, status, durationS: 4,
      result: { total_cost_usd: 0.3, num_turns: 5, rateLimitMessage: 'five-hour limit' } as any,
      error: status === 'failed' ? { message: 'boom' } : null,
    });

    const after = executionRegistry.getExecution(rec.id)!;
    assert.deepEqual(after.metrics, { costUsd: 0.3, numTurns: 5, durationS: 4 });
    assert.equal(after.status, status === 'cancelled' ? 'cancelled' : 'failed');
  });
}

test('teardownExecution(rate-limited) files a failure that names the rate limit', () => {
  const bus = new EventBus();
  const rec = executionRegistry.startLocalExecution({ channel: 'C-teardown', project: 'general', trigger: 'user', backend: 'test' });
  register(rec.id, bus);
  const events: CortexEvent[] = [];
  bus.subscribe('*', (e) => { events.push(e); });

  teardownExecution({
    executionId: rec.id, status: 'rate-limited', durationS: 1,
    result: { total_cost_usd: 0.1, num_turns: 1, rateLimitMessage: 'five-hour limit' } as any,
  });

  assert.equal(executionRegistry.getExecution(rec.id)!.text.error, 'Rate limited: five-hour limit');
  const failed = events.filter((e) => e.type === 'agent.failed');
  assert.equal(failed.length, 1);
  if (failed[0].type === 'agent.failed') assert.equal(failed[0].error, 'Rate limited: five-hour limit');
});

test('stopLiveExecution lets a registered run cancel itself instead of closing its record first', () => {
  const bus = new EventBus();
  runRegistry.setBus(bus);
  const rec = executionRegistry.startLocalExecution({ channel: 'C-teardown', project: 'general', trigger: 'user', backend: 'test' });
  const reasons: string[] = [];
  runRegistry.register({
    channel: 'C-teardown', executionId: rec.id, kind: 'local', kill: () => true, backend: 'test',
    run: {
      steer: async () => 'refused', respondToDialog: () => false,
      cancel: (reason) => {
        reasons.push(reason);
        // The run's own terminal handler, with what it had spent.
        teardownExecution({ executionId: rec.id, status: 'cancelled', durationS: 2, result: { total_cost_usd: 0.4, num_turns: 3 } as any });
      },
    },
  });

  executionRegistry.stopLiveExecution(runRegistry.getById(rec.id)!);

  assert.deepEqual(reasons, ['user']);
  assert.deepEqual(executionRegistry.getExecution(rec.id)!.metrics, { costUsd: 0.4, numTurns: 3, durationS: 2 });
  assert.equal(runRegistry.hasId(rec.id), false);
});
