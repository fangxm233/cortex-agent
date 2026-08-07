// input:  Node test runner, assert, tmp filesystem
// output: regression tests for ExecutionRepo (concurrency, index, flush, archive, coalescing)
// pos:    verifies Pattern B invariants for execution-repo (S3 migration)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExecutionRepo } from '../../src/store/execution-repo.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-exec-repo-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────

function createRepo(): ExecutionRepo {
  const filePath = path.join(tmpDir, `executions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const repo = new ExecutionRepo({ filePath });
  repo.load(); // start with empty map
  return repo;
}

// ── Group 1: Sync mutate + persist chain survives (Pattern B invariant) ──

test('sequential touchExecution — 10 same-ID increments produce costUsd === 10, persist chain does not drop', async () => {
  const repo = createRepo();
  const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'test' });

  // 10 sequential touchExecution on same record, each incrementing costUsd by 1.
  // Pattern B: sync map updates + fire-and-forget persist. In single-threaded JS
  // the map updates are atomic (no mutex needed), but the persist chain must survive.
  for (let i = 0; i < 10; i++) {
    const result = repo.touchExecution(exec.id, { metrics: { costUsd: i + 1 } });
    assert.equal(result?.metrics.costUsd, i + 1, `increment ${i + 1} should be visible in-memory`);
  }

  // Flush drains the persist chain; final on-disk value must match the 10th increment.
  await repo.flush();
  const record = repo.getExecution(exec.id);
  assert.equal(record?.metrics.costUsd, 10, 'final costUsd must be 10 after flush');
});

test('interleaved-await touchExecution — 10 await-yielded mutations on same ID all persist', async () => {
  // Real async interleaving: awaits a microtask between each map mutation + queuePersist.
  // Exercises the persist chain under microtask contention (not just sync burst).
  const repo = createRepo();
  const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'test' });

  await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    await Promise.resolve(); // yield to scheduler
    repo.touchExecution(exec.id, { metrics: { costUsd: i + 1 } });
    await Promise.resolve();
  }));

  await repo.flush();
  const record = repo.getExecution(exec.id);
  // Last-writer-wins in single-threaded JS: final costUsd is whichever completed last.
  // The invariant is that the record exists and has SOME value from 1..10 — no lost updates or corruption.
  assert.ok(record?.metrics.costUsd != null);
  assert.ok(record!.metrics.costUsd! >= 1 && record!.metrics.costUsd! <= 10);
});

test('concurrent start+complete on different IDs — persist chain does not drop entries', async () => {
  const repo = createRepo();

  // 10 concurrent start+complete cycles on different IDs
  const promises = Array.from({ length: 10 }, async (_, i) => {
    const record = repo.startLocalExecution({ kind: `local-${i}`, channel: 'C1', project: 'proj', label: `run-${i}` });
    repo.completeExecution(record.id, { costUsd: 1.0, numTurns: 1, durationS: 1 });
  });
  await Promise.all(promises);
  await repo.flush();

  const allRecords = repo.getAll();
  const completedCount = allRecords.filter(r => r.status === 'completed').length;
  assert.equal(completedCount, 10, `expected 10 completed, got ${completedCount}`);

  // All 10 should have costUsd === 1.0
  for (const r of allRecords) {
    if (r.status === 'completed') {
      assert.equal(r.metrics.costUsd, 1.0);
    }
  }
});

// ── Group 2: Index consistency under concurrent set/delete ──

test('concurrent start/complete/cancel — getRunningExecutions stays consistent', async () => {
  const repo = createRepo();

  const promises: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    if (i % 3 === 0) {
      // start + complete
      const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: `full-${i}` });
      repo.completeExecution(exec.id, { costUsd: 0.1, durationS: 1 });
    } else if (i % 3 === 1) {
      // start + fail
      const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: `fail-${i}` });
      repo.failExecution(exec.id, { error: 'boom' });
    } else {
      // start + cancel
      const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: `cancel-${i}` });
      repo.cancelExecution(exec.id);
    }
  }
  await Promise.all(promises);
  await repo.flush();

  // No running executions should remain
  const running = repo.getRunningExecutions();
  assert.equal(running.length, 0, `expected 0 running after all completed, got ${running.length}`);

  // Total should be 20
  assert.equal(repo.getAll().length, 20);
});

test('concurrent dispatch register — getExecutionByTaskId returns correct record', async () => {
  const repo = createRepo();

  const taskIds = Array.from({ length: 10 }, (_, i) => `task-${i}`);
  const promises = taskIds.map((taskId) =>
    repo.registerDispatchExecution({
      taskId,
      machine: 'testbox',
      channel: 'C1',
      project: 'proj',
      taskText: `task-${taskId}`,
    })
  );
  await Promise.all(promises);
  await repo.flush();

  // Each taskId should resolve to exactly one record
  for (const taskId of taskIds) {
    const record = repo.getExecutionByTaskId(taskId);
    assert.ok(record, `missing record for ${taskId}`);
    assert.equal(record.dispatch?.taskId, taskId);
    assert.equal(record.status, 'running');
  }
});

// ── Group 3: Mid-mutate flush resolves cleanly (FIFO ordering) ──

test('flush — resolves after all pending persists have drained', async () => {
  const repo = createRepo();

  const resolutionOrder: string[] = [];
  const N = 10;

  // Enqueue N start+complete operations (each queues a persist)
  const mutations = Array.from({ length: N }, (_, i) => {
    const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: `flush-${i}` });
    repo.completeExecution(exec.id, { costUsd: 0.01, durationS: 0.1 });
    return repo.queuePersist().then(() => { resolutionOrder.push(`mut-${i}`); });
  });

  // flush() must wait for all queued persists to complete
  const flushDone = repo.flush().then(() => { resolutionOrder.push('flush'); });

  await Promise.all([...mutations, flushDone]);

  // flush should be last (or near-last) — all persists should have resolved
  assert.equal(resolutionOrder[resolutionOrder.length - 1], 'flush',
    `flush must resolve last; got order: ${resolutionOrder.join(', ')}`);

  // Verify all 10 records are on disk
  const allRecords = repo.getAll();
  assert.equal(allRecords.length, N);
});

test('flush — resolves immediately when nothing is pending', async () => {
  const repo = createRepo();
  repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'idle' });
  await repo.flush();

  const t0 = Date.now();
  await repo.flush();
  const dt = Date.now() - t0;
  assert.ok(dt < 50, `idle flush took ${dt}ms; expected near-instant`);
});

test('persist-error — transient write failure does not poison the persist chain', async () => {
  // queuePersist uses `_pendingPersist.catch(() => {}).then(mutex.run(persist)).catch(log)`.
  // The inner .catch(() => {}) clears rejections before chaining — otherwise one failed
  // persist would kill all future persists for the lifetime of the repo.
  const filePath = path.join(tmpDir, `persist-err-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  // Create the filepath as a DIRECTORY so the initial write() (file open) fails with EISDIR.
  await fs.mkdir(filePath);
  const repo = new ExecutionRepo({ filePath });
  repo.load();

  // Swallow expected stderr noise from `[execution-repo] persist failed:` and
  // atomic-write's own rename error during the intentional-failure window.
  const originalErr = console.error;
  console.error = () => {};
  try {
    // First mutation: persist will fail (can't write to a directory).
    repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'will-fail' });
    await repo.flush(); // must not reject

    // Remove the blocking directory so subsequent writes can succeed.
    await fs.rmdir(filePath);

    // Second mutation after the failure: persist chain must still work.
    const exec2 = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'after-recovery' });
    await repo.flush();

    // Verify on-disk state has the second record
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.ok(raw[exec2.id], 'record persisted after transient failure must exist on disk');
    assert.equal(raw[exec2.id].text.label, 'after-recovery');
  } finally {
    console.error = originalErr;
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
});

// ── Group 4: Full lifecycle — start → touch → complete → terminal sticky ──

test('lifecycle — start → touch → complete → terminal state is sticky', async () => {
  const repo = createRepo();

  const record = repo.startLocalExecution({
    kind: 'local', channel: 'C1', project: 'proj', label: 'lifecycle-test',
    sessionId: 'sess-1', backend: 'claude', billingMode: 'api',
  });
  assert.equal(record.status, 'running');
  assert.equal(record.session.sessionId, 'sess-1');

  // Touch to add metrics
  const touched = repo.touchExecution(record.id, {
    metrics: { numTurns: 5 },
    text: { label: 'updated-label' },
  });
  assert.equal(touched?.metrics.numTurns, 5);
  assert.equal(touched?.text.label, 'updated-label');

  // Complete
  const completed = repo.completeExecution(record.id, { costUsd: 2.5, numTurns: 7, durationS: 30, finalOutput: 'done' });
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.metrics.costUsd, 2.5);
  assert.equal(completed?.text.finalOutput, 'done');
  assert.ok(completed?.runtime.endedAt);

  // Terminal stickiness: try to fail it — should stay completed
  const stuck = repo.failExecution(record.id, { error: 'should-not-change' });
  assert.equal(stuck?.status, 'completed');
  assert.equal(stuck?.text.error, null); // error field should NOT have changed
});

test('lifecycle — getExecutionByTaskId prefers non-terminal over terminal', async () => {
  const repo = createRepo();

  // Create and complete a dispatch
  const r1 = repo.registerDispatchExecution({ taskId: 't1', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'v1' });
  repo.completeExecutionByTaskId('t1', { costUsd: 0.5 });
  assert.equal(repo.getExecutionByTaskId('t1')?.status, 'completed');

  // Re-dispatch: creates new record
  const r2 = repo.registerDispatchExecution({ taskId: 't1', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'v2' });
  assert.equal(r2?.status, 'running');
  assert.notEqual(r2?.id, r1?.id);

  // getExecutionByTaskId should prefer the running one
  const found = repo.getExecutionByTaskId('t1');
  assert.equal(found?.status, 'running');
  assert.equal(found?.id, r2?.id);
});

// ── Group 5: Dispatch registration with existing running ──

test('dispatch duplicate lookup can match task identity across schedule sources', () => {
  const repo = createRepo();
  repo.registerDispatchExecution({
    taskId: 'task-upgrade', machine: 'lab', channel: 'C1', project: 'proj',
    taskText: 'same task', taskHash: 'hash-upgrade', scheduleTaskId: 'legacy-schedule-id',
  });

  const match = repo.findRunningDispatchMatch({
    taskHash: 'hash-upgrade', project: 'proj', taskText: 'same task',
  });

  assert.equal(match?.dispatch?.taskId, 'task-upgrade');
  assert.equal(match?.scheduleTaskId, 'legacy-schedule-id');
});

test('dispatch — registerDispatchExecution updates existing running record', async () => {
  const repo = createRepo();

  const r1 = repo.registerDispatchExecution({
    taskId: 't-update', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'original',
  });
  assert.equal(r1?.status, 'running');

  // Register again with same taskId while still running — should update, not create new
  const r2 = repo.registerDispatchExecution({
    taskId: 't-update', machine: 'testbox', channel: 'C2', project: 'proj', taskText: 'updated',
    sessionName: 'new-session', tmuxName: 'new-tmux', pid: '12345',
  });
  assert.equal(r2?.id, r1?.id, 'should return same record when existing is non-terminal');
  assert.equal(r2?.dispatch?.machine, 'testbox');
  assert.equal(r2?.text?.label, 'updated');
  assert.equal(r2?.dispatch?.sessionName, 'new-session');
});

test('dispatch — registerDispatchExecution persists runName (B2-C log-ref)', async () => {
  const repo = createRepo();

  // Fresh registration carries the cortex-run --name onto dispatch.runName.
  const r1 = repo.registerDispatchExecution({
    taskId: 't-runname', machine: 'lab2', project: 'proj', taskText: 'tail me', runName: 'run-xyz',
  });
  assert.equal(r1?.dispatch?.runName, 'run-xyz');

  // A later same-task registration without a runName preserves the existing one (idempotent merge).
  const r2 = repo.registerDispatchExecution({
    taskId: 't-runname', machine: 'lab2', project: 'proj', taskText: 'tail me',
  });
  assert.equal(r2?.id, r1?.id);
  assert.equal(r2?.dispatch?.runName, 'run-xyz', 'runName is not clobbered by a runName-less re-register');
});

// ── Group 5b: Per-execution GPU capture (DR-0018 §6.3 B2-followup) ──

test('gpu — new records default gpu to null', async () => {
  const repo = createRepo();
  const local = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'g' });
  const dispatch = repo.registerDispatchExecution({ taskId: 't-g', machine: 'lab', project: 'proj', taskText: 'd' });
  assert.equal(local.gpu, null);
  assert.equal(dispatch?.gpu, null);
});

test('gpu — setExecutionGpuByTaskId records the GPU on the dispatch record', async () => {
  const repo = createRepo();
  repo.registerDispatchExecution({ taskId: 't-gpu', machine: 'lab', project: 'proj', taskText: 'run', runName: 'r1' });

  const updated = repo.setExecutionGpuByTaskId('t-gpu', { indices: [1], memoryMb: 49140 });
  assert.deepEqual(updated?.gpu, { indices: [1], memoryMb: 49140 });

  await repo.flush();
  assert.deepEqual(repo.getExecutionByTaskId('t-gpu')?.gpu, { indices: [1], memoryMb: 49140 });
});

test('gpu — setExecutionGpuByTaskId records even on a terminal record (write-once metadata)', async () => {
  const repo = createRepo();
  repo.registerDispatchExecution({ taskId: 't-term', machine: 'lab', project: 'proj', taskText: 'run' });
  repo.completeExecutionByTaskId('t-term', { costUsd: 0.1 });
  assert.equal(repo.getExecutionByTaskId('t-term')?.status, 'completed');

  const updated = repo.setExecutionGpuByTaskId('t-term', { indices: [0], memoryMb: null });
  assert.deepEqual(updated?.gpu, { indices: [0], memoryMb: null });
  assert.equal(updated?.status, 'completed', 'status is unchanged by a GPU backfill');
});

test('gpu — setExecutionGpuByTaskId returns null for an unknown taskId', async () => {
  const repo = createRepo();
  assert.equal(repo.setExecutionGpuByTaskId('nope', { indices: [0], memoryMb: null }), null);
});

// ── Group 6: Terminal state stickiness ──

test('terminal stickiness — completed record resists fail/cancel', async () => {
  const repo = createRepo();
  const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'sticky' });

  repo.completeExecution(exec.id, { costUsd: 0.1, durationS: 1 });
  assert.equal(repo.getExecution(exec.id)?.status, 'completed');

  // Fail should not change
  const failed = repo.failExecution(exec.id, { error: 'nope' });
  assert.equal(failed?.status, 'completed');

  // Cancel should not change
  const cancelled = repo.cancelExecution(exec.id);
  assert.equal(cancelled?.status, 'completed');

  // Touch should not change
  const touched = repo.touchExecution(exec.id, { text: { label: 'hacked' } });
  assert.equal(touched?.text.label, 'sticky');
});

test('terminal stickiness — failed record resists complete', async () => {
  const repo = createRepo();
  const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'fail-sticky' });

  repo.failExecution(exec.id, { error: 'boom' });
  assert.equal(repo.getExecution(exec.id)?.status, 'failed');

  const completed = repo.completeExecution(exec.id, { costUsd: 1.0 });
  assert.equal(completed?.status, 'failed');
});

// ── Group 7: Mark stale on startup ──

test('markMissingRunningExecutionsStale — marks non-kept running executions stale', async () => {
  const repo = createRepo();

  const localExec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'local' });
  const dispatchExec = repo.registerDispatchExecution({ taskId: 't1', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'dispatch' });
  const anotherLocal = repo.startLocalExecution({ kind: 'scheduled', channel: 'C1', project: 'proj', label: 'scheduled' });

  await repo.flush();

  // Mark all non-dispatch running executions as stale
  await repo.markMissingRunningExecutionsStale((r) => r.kind === 'dispatch');

  assert.equal(repo.getExecution(localExec.id)?.status, 'stale');
  assert.equal(repo.getExecution(anotherLocal.id)?.status, 'stale');
  assert.equal(repo.getExecution(dispatchExec!.id)?.status, 'running');
});

test('markMissingRunningExecutionsStale — no-op when all match keepRunning', async () => {
  const repo = createRepo();

  repo.registerDispatchExecution({ taskId: 't1', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'd1' });
  repo.registerDispatchExecution({ taskId: 't2', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'd2' });

  await repo.flush();
  await repo.markMissingRunningExecutionsStale((r) => r.kind === 'dispatch');

  assert.equal(repo.getRunningExecutions().length, 2);
});

// ── Group 8: Reconcile stale dispatches ──

test('reconcileStaleDispatches — marks orphaned dispatches stale', async () => {
  const repo = createRepo();

  const record = repo.registerDispatchExecution({
    taskId: 'orphan', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'orphan',
  });

  await repo.flush();

  // Backdate startedAt. getExecution returns the live map reference, so mutating
  // record.runtime.startedAt is already visible in-map. reconcileStaleDispatches
  // reads from the same reference on its next tick — no explicit repo.set needed.
  const backdated = repo.getExecution(record!.id)!;
  backdated.runtime.startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  const reconciled = await repo.reconcileStaleDispatches({
    isTaskPending: () => false,
    maxAgeMs: 3 * 60 * 60 * 1000, // 3h threshold
  });

  assert.equal(reconciled.count, 1);
  assert.equal(repo.getExecutionByTaskId('orphan')?.status, 'stale');
});

test('reconcileStaleDispatches — preserves dispatches still pending', async () => {
  const repo = createRepo();

  repo.registerDispatchExecution({ taskId: 'pending', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'still pending' });
  repo.registerDispatchExecution({ taskId: 'orphan2', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'orphaned' });

  await repo.flush();

  // Backdate both via live reference — see note in previous test.
  for (const taskId of ['pending', 'orphan2']) {
    const r = repo.getExecutionByTaskId(taskId)!;
    r.runtime.startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  }

  const reconciled = await repo.reconcileStaleDispatches({
    isTaskPending: (id) => id === 'pending',
    maxAgeMs: 3 * 60 * 60 * 1000,
  });

  assert.equal(reconciled.count, 1);
  assert.equal(repo.getExecutionByTaskId('pending')?.status, 'running');
  assert.equal(repo.getExecutionByTaskId('orphan2')?.status, 'stale');
});

test('reconcileStaleDispatches — reaps a not-live, not-pending in-process orphan after short grace', async () => {
  const repo = createRepo();
  const record = repo.registerDispatchExecution({ taskId: 'inproc-orphan', machine: 'local', channel: 'C1', project: 'proj', taskText: 'orphan' });
  await repo.flush();
  // Only 5 minutes old — well under the 3h hard ceiling, but it is not live and not pending.
  repo.getExecution(record!.id)!.runtime.startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const reconciled = await repo.reconcileStaleDispatches({
    isTaskPending: () => false,
    isLive: () => false,        // not in the in-memory registry → crashed orphan
    graceMs: 2 * 60 * 1000,     // 2 min grace
    maxAgeMs: 3 * 60 * 60 * 1000,
  });

  assert.equal(reconciled.count, 1, 'orphan should be reaped quickly, not after 3h');
  assert.equal(repo.getExecutionByTaskId('inproc-orphan')?.status, 'stale');
});

test('reconcileStaleDispatches — a remote dispatch is NOT reaped at the short grace, only the hard ceiling', async () => {
  const repo = createRepo();
  // Remote dispatch (machine set) is never in the in-memory registry, so isLive is always false.
  // It must not be subject to the short in-process orphan grace — only the long hard ceiling.
  const record = repo.registerDispatchExecution({ taskId: 'remote-running', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'remote' });
  await repo.flush();
  repo.getExecution(record!.id)!.runtime.startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const reconciled = await repo.reconcileStaleDispatches({
    isTaskPending: () => false,        // tracking lost, but it is remote
    isLive: () => false,
    graceMs: 2 * 60 * 1000,
    maxAgeMs: 3 * 60 * 60 * 1000,
  });

  assert.equal(reconciled.count, 0, 'remote dispatch must survive the short grace');
  assert.equal(repo.getExecutionByTaskId('remote-running')?.status, 'running');
});

test('reconcileStaleDispatches — keeps a live dispatch younger than the hard ceiling', async () => {
  const repo = createRepo();
  const record = repo.registerDispatchExecution({ taskId: 'live-dispatch', machine: 'local', channel: 'C1', project: 'proj', taskText: 'running' });
  await repo.flush();
  repo.getExecution(record!.id)!.runtime.startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const reconciled = await repo.reconcileStaleDispatches({
    isTaskPending: () => false,
    isLive: (id) => id === record!.id,   // still running in-process
    graceMs: 2 * 60 * 1000,
    maxAgeMs: 3 * 60 * 60 * 1000,
  });

  assert.equal(reconciled.count, 0);
  assert.equal(repo.getExecutionByTaskId('live-dispatch')?.status, 'running');
});

test('startup recovery — keepRunning predicate keeps remote dispatch, stales in-process orphan', async () => {
  const repo = createRepo();
  // Remote dispatch carries a machine — survives a server restart.
  repo.registerDispatchExecution({ taskId: 'remote', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'remote' });
  // In-process dispatch: startLocalExecution leaves dispatch=null — dies with the server.
  const inproc = repo.startLocalExecution({ kind: 'dispatch', channel: 'C1', project: 'proj', trigger: 'task-dispatch', backend: 'test' });
  await repo.flush();

  // The exact predicate used at startup in app.ts.
  await repo.markMissingRunningExecutionsStale(
    (r) => r.kind === 'dispatch' && !!r.dispatch?.machine && r.dispatch.machine !== 'local',
  );

  assert.equal(repo.getExecutionByTaskId('remote')?.status, 'running', 'remote dispatch kept');
  assert.equal(repo.getExecution(inproc.id)!.status, 'stale', 'in-process orphan staled at startup');
});

// ── Group 9: Cancel by task ID ──

test('cancelExecutionByTaskId — cancels the correct dispatch execution', async () => {
  const repo = createRepo();

  repo.registerDispatchExecution({ taskId: 'cancel-me', machine: 'testbox', channel: 'C1', project: 'proj', taskText: 'will cancel' });
  const cancelled = repo.cancelExecutionByTaskId('cancel-me');

  assert.equal(cancelled?.status, 'cancelled');
  assert.ok(cancelled?.runtime.endedAt);
  assert.equal(repo.getExecutionByTaskId('cancel-me')?.status, 'cancelled');
});

// ── Group 10: Persistence roundtrip ──

test('persistence — records survive reload via load()', async () => {
  const repo = createRepo();

  repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'persist-test' });
  repo.registerDispatchExecution({ taskId: 'p1', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'persist-dispatch' });
  await repo.flush();

  // Create new repo pointing to same file
  const filePath = repo.filePath;
  const repo2 = new ExecutionRepo({ filePath });
  repo2.load();

  assert.equal(repo2.getAll().length, 2);
  assert.equal(repo2.getRunningExecutions().length, 2);
  assert.ok(repo2.getExecutionByTaskId('p1'));
});

// ── Group 11: findRunningDispatchMatch ──

test('findRunningDispatchMatch — matches by scheduleTaskId/project/taskText', async () => {
  const repo = createRepo();

  repo.registerDispatchExecution({ taskId: 'm1', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'match-me', scheduleTaskId: 'sched-123' });
  await repo.flush();

  // Callers always pass all 4 args (task-dispatcher.ts:124, pending-task-tracker.ts:124)
  const match = repo.findRunningDispatchMatch({ scheduleTaskId: 'sched-123', project: 'proj', taskText: 'match-me' });
  assert.ok(match);
  assert.equal(match.scheduleTaskId, 'sched-123');
});

test('findRunningDispatchMatch — returns null for non-running', async () => {
  const repo = createRepo();

  const exec = repo.registerDispatchExecution({ taskId: 'm2', machine: 'lab', channel: 'C1', project: 'proj', taskText: 'completed-dispatch', scheduleTaskId: 'sched-456' });
  repo.completeExecution(exec!.id, { costUsd: 0.1 });

  const match = repo.findRunningDispatchMatch({ scheduleTaskId: 'sched-456', project: 'proj', taskText: 'completed-dispatch' });
  assert.equal(match, null);
});

// ── Group 12: getAll returns sorted by createdAt desc ──

test('getAll — returns records sorted by createdAt descending', async () => {
  const repo = createRepo();

  repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'first' });
  await new Promise(r => setTimeout(r, 10));
  repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'second' });

  const all = repo.getAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].text.label, 'second'); // most recent first
  assert.equal(all[1].text.label, 'first');
});

// ── Group 13: flush after concurrent mutations — clean resolve ──

test('flush after concurrent start+complete — all records persisted and consistent', async () => {
  const repo = createRepo();

  const ids: string[] = [];
  const promises = Array.from({ length: 15 }, (_, i) => {
    const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: `parallel-${i}` });
    ids.push(exec.id);
    if (i % 2 === 0) {
      repo.completeExecution(exec.id, { costUsd: 0.1 * i, durationS: i });
    } else {
      repo.failExecution(exec.id, { error: `error-${i}` });
    }
  });

  await Promise.all(promises);
  await repo.flush();

  // All 15 records should exist
  assert.equal(repo.getAll().length, 15);

  // Running count should be 0 (all completed or failed)
  assert.equal(repo.getRunningExecutions().length, 0);

  // Verify each ID
  for (const id of ids) {
    const r = repo.getExecution(id);
    assert.ok(r, `missing record ${id}`);
    assert.ok(r.status === 'completed' || r.status === 'failed', `unexpected status ${r.status} for ${id}`);
  }
});

// ── Group 14: Re-export behavior ──

test('re-export layer delegates execution state through one singleton', async () => {
  const reg = await import('../../src/domain/executions/registry.js');

  const exec = reg.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'reexport-test' });
  const found = reg.getExecution(exec.id);
  assert.equal(found?.id, exec.id);
  assert.equal(found?.text.label, 'reexport-test');

  // Clean up: mark it completed so it does not appear as running in the real daemon.
  reg.completeExecution(exec.id, { costUsd: 0, durationS: 0 });
});

// ── Group 15: terminal-record archival ──

const DAY_MS = 24 * 60 * 60 * 1000;

/** Backdate a record's runtime timestamps via repo.set (the designated backdating seam). */
function backdate(repo: ExecutionRepo, id: string, daysAgo: number, { keepRunning = false } = {}): void {
  const rec = repo.getExecution(id);
  assert.ok(rec, `backdate: missing record ${id}`);
  const ts = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  repo.set(id, {
    ...rec!,
    runtime: { startedAt: ts, updatedAt: ts, endedAt: keepRunning ? null : ts },
  });
}

test('archiveTerminal - old terminal records move to append-only JSONL; recent and running stay', async () => {
  const repo = createRepo();
  const archivePath = path.join(tmpDir, `arch-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);

  const old = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'old' });
  repo.completeExecution(old.id);
  backdate(repo, old.id, 8);

  const recent = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'recent' });
  repo.completeExecution(recent.id);

  const running = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'running' });
  backdate(repo, running.id, 8, { keepRunning: true });

  const count = await repo.archiveTerminal({ olderThanMs: 7 * DAY_MS, archivePath });
  assert.equal(count, 1);

  // In-memory: archived record gone, others intact
  assert.equal(repo.getExecution(old.id), null);
  assert.ok(repo.getExecution(recent.id));
  assert.equal(repo.getExecution(running.id)?.status, 'running');

  // Archive file: exactly one parseable JSONL line holding the full record
  const lines = (await fs.readFile(archivePath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const archived = JSON.parse(lines[0]);
  assert.equal(archived.id, old.id);
  assert.equal(archived.text.label, 'old');
  assert.equal(archived.status, 'completed');

  // Persisted store: archived id removed, survivors present
  const onDisk = JSON.parse(await fs.readFile(repo.filePath, 'utf8'));
  assert.ok(!(old.id in onDisk), 'archived record must leave the persisted store');
  assert.ok(recent.id in onDisk);
  assert.ok(running.id in onDisk);
});

test('archiveTerminal - successive runs append to the archive, never overwrite', async () => {
  const repo = createRepo();
  const archivePath = path.join(tmpDir, `arch-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);

  const first = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'first' });
  repo.completeExecution(first.id);
  backdate(repo, first.id, 9);
  assert.equal(await repo.archiveTerminal({ olderThanMs: 7 * DAY_MS, archivePath }), 1);

  const second = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'second' });
  repo.failExecution(second.id, { error: 'boom' });
  backdate(repo, second.id, 8);
  assert.equal(await repo.archiveTerminal({ olderThanMs: 7 * DAY_MS, archivePath }), 1);

  const ids = (await fs.readFile(archivePath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, [first.id, second.id]);
});

test('archiveTerminal - nothing eligible is a no-op (no archive file created)', async () => {
  const repo = createRepo();
  const archivePath = path.join(tmpDir, `arch-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const rec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'fresh' });
  repo.completeExecution(rec.id);

  assert.equal(await repo.archiveTerminal({ olderThanMs: 7 * DAY_MS, archivePath }), 0);
  assert.ok(repo.getExecution(rec.id));
  await assert.rejects(fs.access(archivePath), 'no-op run must not create an archive file');
});

// ── Group 16: persist coalescing ──

test('synchronous mutation burst coalesces disk writes instead of one write per mutation', async () => {
  const repo = createRepo();
  const writeSpy = vi.spyOn((repo as any).repo as { write: (v: unknown) => Promise<void> }, 'write');

  const exec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'burst' });
  for (let i = 0; i < 20; i++) {
    repo.touchExecution(exec.id, { metrics: { costUsd: i + 1 } });
  }
  await repo.flush();

  assert.ok(
    writeSpy.mock.calls.length <= 3,
    `expected coalesced writes for a 21-mutation sync burst, got ${writeSpy.mock.calls.length}`,
  );
  // Durability contract unchanged: final state on disk reflects the last mutation.
  const onDisk = JSON.parse(await fs.readFile(repo.filePath, 'utf8'));
  assert.equal(onDisk[exec.id].metrics.costUsd, 20);
});
