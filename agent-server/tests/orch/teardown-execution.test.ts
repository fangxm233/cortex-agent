// input:  node:test, teardownExecution helper, executionRegistry + runningExecutions singletons, EventBus
// output: regression tests for teardownExecution — closes BOTH the persistent record ledger and the
//         in-memory registry with a balanced agent.* lifecycle event (the Stage 2 / P5 fix).
// pos:    validates that a terminal transition finalizes the persistent record AND publishes an event,
//         which thread-step teardown previously skipped (used event-less remove()).

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as executionRegistry from '../../src/domain/executions/registry.js';
import { teardownExecution } from '../../src/domain/executions/registry.js';
import { runningExecutions } from '../../src/core/running-executions.js';
import { EventBus } from '../../src/events/index.js';
import type { CortexEvent } from '../../src/events/index.js';

function register(executionId: string, bus: EventBus): void {
  runningExecutions.setBus(bus);
  runningExecutions.register({
    threadId: null, channel: 'C-teardown', agentSlotId: null,
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
  assert.equal(runningExecutions.hasId(rec.id), false);
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
  assert.equal(runningExecutions.hasId(rec.id), false);
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
  runningExecutions.setBus(bus);
  runningExecutions.register({ threadId: null, channel: 'C-teardown', agentSlotId: null, executionId: rec.id, kind: 'local', kill: () => { killed = true; return true; }, backend: 'test' });

  const events: CortexEvent[] = [];
  bus.subscribe('*', (e) => { events.push(e); });

  teardownExecution({ executionId: rec.id, status: 'cancelled', durationS: 1 });

  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'cancelled');
  assert.equal(killed, true, 'cancelled teardown must kill the live handle');
  assert.equal(runningExecutions.hasId(rec.id), false);
  // A balanced terminal event is published (agent.started is no longer dangling on cancel).
  assert.equal(events.filter((e) => e.type === 'agent.superseded').length, 1);
});

test('teardownExecution(null executionId) is a safe no-op', () => {
  assert.doesNotThrow(() => teardownExecution({ executionId: null, status: 'completed', durationS: 0 }));
});
