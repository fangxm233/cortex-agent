// input:  Node test runner + createUiService facade + a real ExecutionLogTailer + EventBus
// output: subscribeExecutionLog (B2-C) regression — ref-count start/stop, executionId filtering,
//         bounded backpressure, and clean close for an unresolvable execution
// pos:    B2-C (task 6c5b): the tRPC-facing facade method wiring the tailer ref-count to the
//         subscription lifecycle over the existing bounded queue.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../../../src/events/event-bus.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import { ExecutionLogTailer } from '../../../src/domain/executions/log-tailer.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

/** Deps backed by a REAL EventBus + REAL ExecutionLogTailer so ref-count transitions are exercised
 *  end-to-end. getExecution returns records whose dispatch.runName drives the resolver. */
function makeDeps(bus: EventBus, tailer: ExecutionLogTailer, records: Record<string, any>): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: {
      getExecution: (id: string) => records[id] ?? null,
      getAll: () => Object.values(records),
      cancelExecution: () => null,
    },
    executionLogTailer: tailer,
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, monthlyBudget: 0, budgetScope: 'global' as const, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    bus,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({}) } as any,
  };
}

/** A local dispatch record carrying a runName → resolves to a local output.log location. */
const rec = (runName: string | null) => ({ dispatch: { machine: null, runName } });

test('subscribeExecutionLog ref-counts the tailer: first sub starts, last close stops', async () => {
  const bus = new EventBus();
  const tailer = new ExecutionLogTailer({ read: async () => ({ chunk: '', nextOffset: 0 }), pollIntervalMs: 0 });
  tailer.setBus(bus);
  const ui = createUiService(makeDeps(bus, tailer, { e1: rec('run1') }));

  assert.equal(tailer.refCount('e1'), 0);
  const sub1 = ui.subscribeExecutionLog('e1');
  assert.equal(tailer.refCount('e1'), 1, 'first subscriber starts the tail');
  const sub2 = ui.subscribeExecutionLog('e1');
  assert.equal(tailer.refCount('e1'), 2, 'second subscriber bumps the ref-count');

  sub1.close();
  assert.equal(tailer.refCount('e1'), 1, 'one consumer left → tail stays alive');
  sub2.close();
  assert.equal(tailer.refCount('e1'), 0, 'last close tears the tail down');

  // Double-close is a no-op and must not push the ref-count negative.
  sub2.close();
  assert.equal(tailer.refCount('e1'), 0);
});

test('subscribeExecutionLog delivers execution.log for its id and filters out other ids', async () => {
  const bus = new EventBus();
  const tailer = new ExecutionLogTailer({ read: async () => ({ chunk: '', nextOffset: 0 }), pollIntervalMs: 0 });
  tailer.setBus(bus);
  const ui = createUiService(makeDeps(bus, tailer, { e1: rec('run1'), e2: rec('run2') }));

  const sub = ui.subscribeExecutionLog('e1');
  const iter = sub[Symbol.asyncIterator]();

  // An event for a different execution must NOT be delivered to this subscription…
  bus.publish({ type: 'execution.log', executionId: 'e2', seq: 0, lines: ['other'] } as any);
  // …only the matching one is.
  bus.publish({ type: 'execution.log', executionId: 'e1', seq: 0, lines: ['hello', 'world'] } as any);

  const first = await iter.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, 'execution.log');
  assert.equal((first.value.payload as any).executionId, 'e1');
  assert.deepEqual((first.value.payload as any).lines, ['hello', 'world']);

  sub.close();
  assert.equal(tailer.refCount('e1'), 0);
});

test('subscribeExecutionLog is bounded: flooding past the queue cap drops oldest + emits a synthetic marker', async () => {
  const bus = new EventBus();
  const tailer = new ExecutionLogTailer({ read: async () => ({ chunk: '', nextOffset: 0 }), pollIntervalMs: 0 });
  tailer.setBus(bus);
  const ui = createUiService(makeDeps(bus, tailer, { e1: rec('run1') }));

  const sub = ui.subscribeExecutionLog('e1');

  // Flood well past QUEUE_CAP (256) BEFORE consuming — the bounded queue drops oldest.
  for (let i = 0; i < 400; i++) {
    bus.publish({ type: 'execution.log', executionId: 'e1', seq: i, lines: [`line${i}`] } as any);
  }

  // Drain what is buffered; assert real log lines are bounded to the cap and a marker was synthesised.
  const iter = sub[Symbol.asyncIterator]();
  let realCount = 0;
  let sawDropped = false;
  // Drain non-blockingly by racing a sentinel that wins once the queue is empty.
  for (let guard = 0; guard < 2000; guard++) {
    const next = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((r) => setImmediate(() => r({ done: true, value: undefined }))),
    ]);
    if (next.done) break;
    if ((next.value as any).type === 'ui-subscribe.dropped') sawDropped = true;
    else realCount++;
  }
  assert.ok(sawDropped, 'overflow must synthesise a ui-subscribe.dropped marker');
  assert.ok(realCount <= 256, `retained log lines ${realCount} must stay within the 256-line queue cap`);
  assert.ok(realCount > 0, 'the newest log lines must be retained');

  sub.close();
  assert.equal(tailer.refCount('e1'), 0);
});

test('subscribeExecutionLog returns a cleanly-closed stream when the location is unresolvable (no runName)', async () => {
  const bus = new EventBus();
  const tailer = new ExecutionLogTailer({ read: async () => ({ chunk: '', nextOffset: 0 }), pollIntervalMs: 0 });
  tailer.setBus(bus);
  // e-none has a record but no runName; e-missing is unknown entirely.
  const ui = createUiService(makeDeps(bus, tailer, { 'e-none': rec(null) }));

  for (const id of ['e-none', 'e-missing']) {
    const sub = ui.subscribeExecutionLog(id);
    assert.equal(tailer.refCount(id), 0, 'no tail is started when the log is unresolvable');
    const iter = sub[Symbol.asyncIterator]();
    const r = await iter.next();
    assert.equal(r.done, true, 'the stream ends immediately');
    sub.close(); // idempotent, must not throw
  }
});
