// input:  Node test runner, RunningExecutions + EventBus
// output: regression tests for RunningExecutions — executionId-keyed registry with channel/thread
//         secondary indices. Validates P3 fix (multiple live executions per channel coexist),
//         balanced lifecycle events, and identity-guarded index cleanup.
// pos:    validates the Stage 1 backbone refactor (plan: execution lifecycle).

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RunningExecutions } from '../../src/core/running-executions.js';
import type { RunningExecutionInput } from '../../src/core/running-executions.js';
import { EventBus } from '../../src/events/index.js';
import type { CortexEvent } from '../../src/events/index.js';

function makeInput(overrides: Partial<RunningExecutionInput> = {}): RunningExecutionInput {
  return {
    threadId: null,
    channel: null,
    agentSlotId: null,
    executionId: 'E-default',
    kind: null,
    kill: () => true,
    backend: 'claude',
    ...overrides,
  };
}

function makeKillTracker(): { killed: boolean; kill: () => boolean } {
  let killed = false;
  return {
    get killed() { return killed; },
    kill() { killed = true; return true; },
  };
}

function collectEvents(bus: EventBus): CortexEvent[] {
  const events: CortexEvent[] = [];
  bus.subscribe('*', (e) => { events.push(e); });
  return events;
}

// ── Index consistency ─────────────────────────────────────────────────

test('register by executionId: resolvable by id and channel; not by unknown thread', () => {
  const exec = new RunningExecutions();
  exec.register(makeInput({ executionId: 'E1', channel: 'C123' }));

  assert.ok(exec.hasId('E1'));
  assert.equal(exec.getById('E1')!.registryKey, 'E1');
  assert.equal(exec.getByChannel('C123').length, 1);
  assert.equal(exec.getByChannel('C123')[0]!.executionId, 'E1');
  assert.equal(exec.getByThreadId('T1'), null);
});

test('register returns the primary key (executionId)', () => {
  const exec = new RunningExecutions();
  const key = exec.register(makeInput({ executionId: 'E1', channel: 'C1' }));
  assert.equal(key, 'E1');
});

// ── Live numTurns (S4 chat: real agent-turn snapshot on the running execution) ──

test('numTurns: defaults to null on register; setNumTurns updates the live entry', () => {
  const exec = new RunningExecutions();
  exec.register(makeInput({ executionId: 'E1', channel: 'C1' }));
  assert.equal(exec.getById('E1')!.numTurns, null);

  exec.setNumTurns('E1', 3);
  assert.equal(exec.getById('E1')!.numTurns, 3);
  // Visible through the channel index too (the sessions.list snapshot reads it there).
  assert.equal(exec.getByChannel('C1')[0]!.numTurns, 3);

  exec.setNumTurns('E1', 5);
  assert.equal(exec.getById('E1')!.numTurns, 5);
});

test('setNumTurns: no-op for an unknown key', () => {
  const exec = new RunningExecutions();
  // Must not throw when the execution is already gone / never registered.
  assert.doesNotThrow(() => exec.setNumTurns('missing', 2));
});

test('register with threadId: appears in byThreadId and byChannel; remove(id) cleans all', () => {
  const exec = new RunningExecutions();
  exec.register(makeInput({ executionId: 'E1', threadId: 'T1', channel: 'C123' }));

  assert.equal(exec.getByThreadId('T1')!.executionId, 'E1');
  assert.equal(exec.getByChannel('C123').length, 1);

  exec.remove('E1');
  assert.equal(exec.hasId('E1'), false);
  assert.equal(exec.getByThreadId('T1'), null);
  assert.equal(exec.getByChannel('C123').length, 0);
  assert.equal(exec.hasChannel('C123'), false);
});

// ── P3 regression: multiple live executions per channel ────────────────

test('two executions on the same channel coexist — neither evicts the other', () => {
  const exec = new RunningExecutions();
  const hA = makeKillTracker();
  const hB = makeKillTracker();
  exec.register(makeInput({ executionId: 'EA', channel: 'C1', kill: () => hA.kill() }));
  exec.register(makeInput({ executionId: 'EB', channel: 'C1', kill: () => hB.kill() }));

  // Both are tracked
  assert.equal(exec.getByChannel('C1').length, 2);
  assert.ok(exec.getById('EA') !== null);
  assert.ok(exec.getById('EB') !== null);

  // Killing one leaves the other live (no silent eviction / handle leak)
  assert.equal(exec.killById('EA'), true);
  assert.equal(hA.killed, true);
  assert.equal(hB.killed, false);
  assert.equal(exec.getById('EA'), null);
  assert.equal(exec.getByChannel('C1').length, 1);
  assert.equal(exec.getByChannel('C1')[0]!.executionId, 'EB');
});

test('killByChannel kills every execution on the channel and returns the count', () => {
  const exec = new RunningExecutions();
  const hA = makeKillTracker();
  const hB = makeKillTracker();
  exec.register(makeInput({ executionId: 'EA', channel: 'C1', kill: () => hA.kill() }));
  exec.register(makeInput({ executionId: 'EB', channel: 'C1', kill: () => hB.kill() }));
  exec.register(makeInput({ executionId: 'EC', channel: 'C2' }));

  const n = exec.killByChannel('C1');
  assert.equal(n, 2);
  assert.equal(hA.killed, true);
  assert.equal(hB.killed, true);
  assert.equal(exec.getByChannel('C1').length, 0);
  // Other channel untouched
  assert.equal(exec.getByChannel('C2').length, 1);

  assert.equal(exec.killByChannel('C1'), 0);
});

// ── Kill chain ────────────────────────────────────────────────────────

test('killById: calls kill(), removes from all indices, returns true; second call false', () => {
  const exec = new RunningExecutions();
  const handle = makeKillTracker();
  exec.register(makeInput({ executionId: 'E1', threadId: 'T1', channel: 'C1', kill: () => handle.kill() }));

  assert.equal(exec.killById('E1'), true);
  assert.equal(handle.killed, true);
  assert.equal(exec.hasId('E1'), false);
  assert.equal(exec.getByThreadId('T1'), null);
  assert.equal(exec.getByChannel('C1').length, 0);

  assert.equal(exec.killById('E1'), false);
});

test('killByThreadId: resolves via byThreadId, kills, cleans all indices', () => {
  const exec = new RunningExecutions();
  const handle = makeKillTracker();
  exec.register(makeInput({ executionId: 'E1', threadId: 'T1', channel: 'C1', kill: () => handle.kill() }));

  assert.equal(exec.killByThreadId('T1'), true);
  assert.equal(handle.killed, true);
  assert.equal(exec.hasId('E1'), false);
  assert.equal(exec.getByThreadId('T1'), null);

  assert.equal(exec.killByThreadId('T1'), false);
});

// ── Event publishing ──────────────────────────────────────────────────

test('register with executionId publishes agent.started', () => {
  const bus = new EventBus();
  const events = collectEvents(bus);
  const exec = new RunningExecutions(bus);

  exec.register(makeInput({ channel: 'C123', executionId: 'exec-1', backend: 'claude' }));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent.started');
  if (events[0].type === 'agent.started') {
    assert.equal(events[0].channel, 'C123');
    assert.equal(events[0].executionId, 'exec-1');
    assert.equal(events[0].backend, 'claude');
  }
});

test('complete publishes agent.completed with cost + durationMs and removes entry', async () => {
  const bus = new EventBus();
  const exec = new RunningExecutions(bus);
  exec.register(makeInput({ channel: 'C123', executionId: 'exec-2', backend: 'pi' }));

  await new Promise((r) => setTimeout(r, 5));

  const events = collectEvents(bus);
  const ok = exec.complete('exec-2', 0.42);

  assert.equal(ok, true);
  assert.equal(exec.hasId('exec-2'), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent.completed');
  if (events[0].type === 'agent.completed') {
    assert.equal(events[0].executionId, 'exec-2');
    assert.equal(events[0].cost, 0.42);
    assert.ok(events[0].durationMs >= 0);
  }

  assert.equal(exec.complete('exec-2'), false);
});

test('fail publishes agent.failed with error and removes entry', () => {
  const bus = new EventBus();
  const exec = new RunningExecutions(bus);
  exec.register(makeInput({ channel: 'C123', executionId: 'exec-3', backend: 'claude' }));

  const events = collectEvents(bus);
  const ok = exec.fail('exec-3', 'boom');

  assert.equal(ok, true);
  assert.equal(exec.hasId('exec-3'), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent.failed');
  if (events[0].type === 'agent.failed') {
    assert.equal(events[0].executionId, 'exec-3');
    assert.equal(events[0].error, 'boom');
  }
});

test('supersede(id) kills handle, removes entry, publishes agent.superseded', () => {
  const bus = new EventBus();
  const exec = new RunningExecutions(bus);
  const handle = makeKillTracker();
  exec.register(makeInput({ channel: 'C123', executionId: 'exec-4', kill: () => handle.kill() }));

  const events = collectEvents(bus);
  const ok = exec.supersede('exec-4', 'edit');

  assert.equal(ok, true);
  assert.equal(handle.killed, true);
  assert.equal(exec.hasId('exec-4'), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent.superseded');
  if (events[0].type === 'agent.superseded') {
    assert.equal(events[0].executionId, 'exec-4');
    assert.equal(events[0].reason, 'edit');
  }
});

test('supersedeByChannel kills+supersedes every entry on the channel (edit flow)', () => {
  const bus = new EventBus();
  const exec = new RunningExecutions(bus);
  const hA = makeKillTracker();
  const hB = makeKillTracker();
  exec.register(makeInput({ channel: 'C1', executionId: 'EA', kill: () => hA.kill() }));
  exec.register(makeInput({ channel: 'C1', executionId: 'EB', kill: () => hB.kill() }));

  const events = collectEvents(bus);
  const n = exec.supersedeByChannel('C1', 'edit');

  assert.equal(n, 2);
  assert.equal(hA.killed, true);
  assert.equal(hB.killed, true);
  assert.equal(exec.getByChannel('C1').length, 0);
  assert.equal(events.filter((e) => e.type === 'agent.superseded').length, 2);
});

// ── kind field (Stage 4 dispatch accounting) ──────────────────────────

test('register stores the kind field for dispatch accounting', () => {
  const exec = new RunningExecutions();
  exec.register(makeInput({ executionId: 'E1', channel: 'C1', kind: 'dispatch' }));
  assert.equal(exec.getById('E1')!.kind, 'dispatch');
});

// ── Identity-guarded index cleanup ─────────────────────────────────────

test('removing an entry with a shared threadId must not corrupt byThreadId for the active entry', () => {
  const exec = new RunningExecutions();
  exec.register(makeInput({ executionId: 'EA', threadId: 'T', channel: 'C1' }));
  exec.register(makeInput({ executionId: 'EB', threadId: 'T', channel: 'C2' }));
  // byThreadId['T'] = EB (second registration wins)

  exec.remove('EA');
  // byThreadId['T'] must still point to EB
  assert.equal(exec.getByThreadId('T')!.executionId, 'EB');
});

test('ad-hoc registryKey (no executionId) is supported and keyed by registryKey', () => {
  const exec = new RunningExecutions();
  const key = exec.register(makeInput({ executionId: null, registryKey: 'hook:my-handle', channel: 'C1' }));
  assert.equal(key, 'hook:my-handle');
  assert.equal(exec.getById('hook:my-handle')!.registryKey, 'hook:my-handle');
  exec.remove('hook:my-handle');
  assert.equal(exec.getById('hook:my-handle'), null);
});

// ── Misc ───────────────────────────────────────────────────────────────

test('getAll returns snapshot of all registered entries', () => {
  const exec = new RunningExecutions();
  assert.equal(exec.getAll().length, 0);

  exec.register(makeInput({ executionId: 'E1', channel: 'C1' }));
  exec.register(makeInput({ executionId: 'E2', channel: 'C2' }));
  assert.equal(exec.getAll().length, 2);

  exec.remove('E1');
  assert.equal(exec.getAll().length, 1);
  assert.equal(exec.getAll()[0]!.executionId, 'E2');
});

test('getById returns null for unknown id', () => {
  const exec = new RunningExecutions();
  exec.register(makeInput({ executionId: 'E1' }));
  assert.equal(exec.getById('E1')!.executionId, 'E1');
  assert.equal(exec.getById('nope'), null);
});

test('remove is a no-op for a non-existent id', () => {
  const exec = new RunningExecutions();
  exec.remove('nonexistent');
  assert.equal(exec.hasId('nonexistent'), false);
});

test('register stores startTime as a recent timestamp', () => {
  const exec = new RunningExecutions();
  const before = Date.now();
  exec.register(makeInput({ executionId: 'E1' }));
  const entry = exec.getById('E1')!;
  assert.ok(entry.startTime >= before);
  assert.ok(entry.startTime <= Date.now());
});

test('setBus after construction: events not published until bus is wired', () => {
  const exec = new RunningExecutions();
  exec.register(makeInput({ channel: 'C123', executionId: 'exec-5' }));

  const bus = new EventBus();
  const events = collectEvents(bus);
  exec.setBus(bus);

  exec.complete('exec-5', 1.0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent.completed');
});
