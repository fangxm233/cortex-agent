import { test, beforeAll, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExecutionRepo } from '../../src/store/execution-repo.js';
import { SessionTotalsCarryRepo } from '../../src/store/session-totals-repo.js';
import { toSessionTotals } from '../../src/store/session-totals.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-exec-repo-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────

function createRepo(sessionTotals?: SessionTotalsCarryRepo): ExecutionRepo {
  const filePath = path.join(tmpDir, `executions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const repo = new ExecutionRepo({ filePath, sessionTotals });
  repo.load(); // start with empty map
  return repo;
}

function createCarry(): SessionTotalsCarryRepo {
  return new SessionTotalsCarryRepo(
    path.join(tmpDir, `totals-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
  );
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

// ── Group 7: Mark stale on startup ──

test('markMissingRunningExecutionsStale — marks non-kept running executions stale', async () => {
  const repo = createRepo();

  const localExec = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'local' });
  const kept = repo.startLocalExecution({ kind: 'scheduled', channel: 'C1', project: 'proj', label: 'scheduled' });
  const anotherLocal = repo.startLocalExecution({ kind: 'local', channel: 'C2', project: 'proj', label: 'local-2' });

  await repo.flush();

  // Mark every running execution except the scheduled one as stale
  await repo.markMissingRunningExecutionsStale((r) => r.kind === 'scheduled');

  assert.equal(repo.getExecution(localExec.id)?.status, 'stale');
  assert.equal(repo.getExecution(anotherLocal.id)?.status, 'stale');
  assert.equal(repo.getExecution(kept.id)?.status, 'running');
});

test('markMissingRunningExecutionsStale — no-op when all match keepRunning', async () => {
  const repo = createRepo();

  repo.startLocalExecution({ kind: 'scheduled', channel: 'C1', project: 'proj', label: 's1' });
  repo.startLocalExecution({ kind: 'scheduled', channel: 'C1', project: 'proj', label: 's2' });

  await repo.flush();
  await repo.markMissingRunningExecutionsStale((r) => r.kind === 'scheduled');

  assert.equal(repo.getRunningExecutions().length, 2);
});

// ── Group 10: Persistence roundtrip ──

test('persistence — records survive reload via load()', async () => {
  const repo = createRepo();

  repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'persist-test' });
  const scheduled = repo.startLocalExecution({ kind: 'scheduled', channel: 'C1', project: 'proj', label: 'persist-scheduled' });
  await repo.flush();

  // Create new repo pointing to same file
  const filePath = repo.filePath;
  const repo2 = new ExecutionRepo({ filePath });
  repo2.load();

  assert.equal(repo2.getAll().length, 2);
  assert.equal(repo2.getRunningExecutions().length, 2);
  assert.ok(repo2.getExecution(scheduled.id));
});

test('persistence — a new record carries no thread or dispatch data, and a legacy one still loads', async () => {
  const repo = createRepo();
  const fresh = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', label: 'fresh' });
  assert.equal('thread' in fresh, false);
  assert.equal('dispatch' in fresh, false);
  await repo.flush();
  const onDisk = JSON.parse(await fs.readFile(repo.filePath, 'utf8'))[fresh.id];
  assert.equal('thread' in onDisk, false);
  assert.equal('dispatch' in onDisk, false);

  const legacy = {
    ...fresh, id: 'exec_dispatch_legacy', kind: 'dispatch', status: 'completed',
    thread: { threadId: 'thr_1', agentSlotId: 'main' },
    dispatch: { taskId: 't1', taskHash: null, machine: 'lab', scheduleTaskId: null, sessionName: null, tmuxName: null, pid: null },
  };
  repo.set(legacy.id, legacy);
  await repo.flush();

  const repo2 = new ExecutionRepo({ filePath: repo.filePath });
  repo2.load();
  assert.equal(repo2.getExecution(legacy.id)?.kind, 'dispatch');
  assert.equal(repo2.getExecution(legacy.id)?.dispatch?.taskId, 't1');
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

test('archiveTerminal - a session keeps its totals after its runs are archived away', async () => {
  // Without the carry, summing the live registry would quietly SHRINK a long session's cumulative
  // cost every time a week-old run left it — the number on screen would silently become wrong.
  const carry = createCarry();
  const repo = createRepo(carry);
  const archivePath = path.join(tmpDir, `arch-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);

  const old = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', sessionId: 's1' });
  repo.completeExecution(old.id, { numTurns: 12, costUsd: 4.5, durationS: 60 });
  backdate(repo, old.id, 8);
  const child = repo.startLocalExecution({ kind: 'local', channel: 'C1', project: 'proj', ownerSessionId: 's1' });
  repo.completeExecution(child.id, { numTurns: 5, costUsd: 1.25, durationS: 20 });
  backdate(repo, child.id, 8);

  assert.equal(await repo.archiveTerminal({ olderThanMs: 7 * DAY_MS, archivePath }), 2);

  const carried = await carry.read();
  assert.deepEqual(toSessionTotals(carried.sessions['s1']), {
    runs: 1, turns: 12, activeMs: 60_000, costUsd: 5.75, subagentCostUsd: 1.25,
  });
  // The watermark lets the live pass skip anything this carry already owns.
  assert.ok(carried.carriedThrough && carried.carriedThrough > new Date(Date.now() - 8 * DAY_MS).toISOString());
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
