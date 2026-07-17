// input:  Node test runner + execution registry + task-lock primitives
// output: regression tests for auto lock-release on terminal execution transitions + suspend path
// pos:    verifies complete/fail/cancel/stale terminal paths AND releaseExecutionLocks (thread_wait suspend) release owned task locks
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';

// Import singleton-backed registry (uses the real executionRepo singleton)
import * as executionRegistry from '../src/domain/executions/registry.js';
import { executionRepo } from '../src/store/execution-repo.js';
import { readLock, acquireLock, releaseLock } from '../src/domain/tasks/system/task-lock.js';

// ── Helpers ────────────────────────────────────────────────────

let projectSeq = 0;
let taskIdSeq = 0;

/** Create a temp project under the real PROJECTS_DIR and return a cleanup fn. */
function makeTestProject(): { project: string; cleanup: () => void } {
  const project = `_elrt_${++projectSeq}`;
  // Use unique task IDs to avoid collisions with other concurrent tests
  const taskId = `e${(++taskIdSeq).toString(16).padStart(3, '0')}`;
  const dir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  const tasksPath = path.join(dir, 'TASKS.yaml');
  const existed = fs.existsSync(tasksPath);
  const backup = existed ? fs.readFileSync(tasksPath, 'utf8') : null;
  fs.writeFileSync(tasksPath, `tasks:\n  - id: ${taskId}\n    text: "test"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`);

  const cleanup = () => {
    if (backup !== null) fs.writeFileSync(tasksPath, backup);
    else { try { fs.unlinkSync(tasksPath); } catch {} }
    try { fs.rmdirSync(dir); } catch {}
  };

  return { project, cleanup };
}

/** Track created execution IDs so we can remove them from the singleton map after test. */
const createdExecIds: string[] = [];

afterAll(() => {
  for (const id of createdExecIds) {
    executionRepo['map']?.delete(id);
  }
  try { executionRepo.queuePersist(); } catch {}
});

function startExec(label: string): string {
  const record = executionRegistry.startLocalExecution({
    kind: 'local',
    channel: 'test',
    project: '_elrt_general',
    label,
  });
  createdExecIds.push(record.id);
  return record.id;
}

// ── Test cases ─────────────────────────────────────────────────

// A: completeExecution releases lock
test('completeExecution auto-releases lock owned by the executionId', () => {
  const { project, cleanup } = makeTestProject();
  const execId = startExec('lock-test-complete');

  try {
    // Acquire lock with execId as owner
    const acq = acquireLock(project, { owner: execId });
    assert.equal(acq.acquired, true, 'lock should be acquired');
    assert.equal(readLock(project)?.owner, execId);

    // Complete the execution — should auto-release lock
    const result = executionRegistry.completeExecution(execId);
    assert.ok(result);
    assert.equal(result.status, 'completed');

    // Lock should be released
    assert.equal(readLock(project), null, 'lock should be released after completeExecution');
  } finally {
    try { releaseLock(project, execId, { force: true }); } catch {}
    cleanup();
  }
});

// B: failExecution releases lock
test('failExecution auto-releases lock owned by the executionId', () => {
  const { project, cleanup } = makeTestProject();
  const execId = startExec('lock-test-fail');

  try {
    acquireLock(project, { owner: execId });
    assert.equal(readLock(project)?.owner, execId);

    const result = executionRegistry.failExecution(execId);
    assert.ok(result);
    assert.equal(result.status, 'failed');

    assert.equal(readLock(project), null, 'lock should be released after failExecution');
  } finally {
    try { releaseLock(project, execId, { force: true }); } catch {}
    cleanup();
  }
});

// C: cancelExecution releases lock
test('cancelExecution auto-releases lock owned by the executionId', () => {
  const { project, cleanup } = makeTestProject();
  const execId = startExec('lock-test-cancel');

  try {
    acquireLock(project, { owner: execId });
    assert.equal(readLock(project)?.owner, execId);

    const result = executionRegistry.cancelExecution(execId);
    assert.ok(result);
    assert.equal(result.status, 'cancelled');

    assert.equal(readLock(project), null, 'lock should be released after cancelExecution');
  } finally {
    try { releaseLock(project, execId, { force: true }); } catch {}
    cleanup();
  }
});

// D: markMissingRunningExecutionsStale releases lock
test('markMissingRunningExecutionsStale auto-releases lock', async () => {
  const { project, cleanup } = makeTestProject();
  const execId = startExec('lock-test-stale');

  try {
    acquireLock(project, { owner: execId });
    assert.equal(readLock(project)?.owner, execId);

    // Stale only OUR execution by keeping all other records running
    const staled = await executionRegistry.markMissingRunningExecutionsStale(
      (record) => record.id !== execId,
    );
    assert.ok(staled.includes(execId), 'execution should be in staled list');

    assert.equal(readLock(project), null, 'lock should be released after markMissingRunningExecutionsStale');
  } finally {
    try { releaseLock(project, execId, { force: true }); } catch {}
    cleanup();
  }
});

// E: execution with no lock — completeExecution does not error
test('completeExecution does not error when execution holds no lock', () => {
  const execId = startExec('lock-test-no-lock');

  // completeExecution should succeed even with no lock
  const result = executionRegistry.completeExecution(execId);
  assert.ok(result);
  assert.equal(result.status, 'completed');
  // No exception thrown = pass
});

// G: releaseExecutionLocks releases the lock owned by the executionId (suspend path, DR-0014).
//    A manager that acquired a lock (e.g. `decompose --auto-lock`) and then suspends on its
//    children must release BEFORE yielding — otherwise the lock is held across the whole child
//    wait and the terminal auto-release later can't match it (re-entry uses a new executionId).
test('releaseExecutionLocks releases the lock owned by the executionId (suspend path)', () => {
  const { project, cleanup } = makeTestProject();
  const execId = startExec('lock-test-suspend');

  try {
    acquireLock(project, { owner: execId });
    assert.equal(readLock(project)?.owner, execId);

    // Simulate thread_wait suspension: release without ending the execution.
    executionRegistry.releaseExecutionLocks(execId);

    assert.equal(readLock(project), null, 'lock should be released on suspend');
    // Execution is still live (NOT terminal) — suspend does not complete it.
    assert.notEqual(executionRepo.getExecution(execId)?.status, 'completed');
  } finally {
    try { releaseLock(project, execId, { force: true }); } catch {}
    cleanup();
  }
});

// H: releaseExecutionLocks(execB) does NOT release a lock held by execA (owner-match).
test('releaseExecutionLocks(execB) does not release lock held by execA', () => {
  const { project, cleanup } = makeTestProject();
  const execA = startExec('lock-test-suspend-a');
  const execB = startExec('lock-test-suspend-b');

  try {
    acquireLock(project, { owner: execA });
    assert.equal(readLock(project)?.owner, execA);

    executionRegistry.releaseExecutionLocks(execB);

    const lock = readLock(project);
    assert.ok(lock);
    assert.equal(lock!.owner, execA, 'execA lock should still be held');
  } finally {
    try { releaseLock(project, execA, { force: true }); } catch {}
    cleanup();
  }
});

// I: releaseExecutionLocks with no lock / null id — does not error.
test('releaseExecutionLocks is a no-op when no lock is held or id is null', () => {
  const execId = startExec('lock-test-suspend-nolock');
  executionRegistry.releaseExecutionLocks(execId); // no lock held
  executionRegistry.releaseExecutionLocks(null);   // null id
  executionRegistry.releaseExecutionLocks(undefined);
  // No exception = pass
});

// F: execution A holds lock, execution B calls completeExecution(B) — does NOT release A's lock
test('completeExecution(execB) does not release lock held by execA', () => {
  const { project, cleanup } = makeTestProject();
  const execA = startExec('lock-test-owner-a');
  const execB = startExec('lock-test-owner-b');

  try {
    // execA acquires lock
    acquireLock(project, { owner: execA });
    assert.equal(readLock(project)?.owner, execA);

    // completeExecution for execB — should NOT release execA's lock
    const result = executionRegistry.completeExecution(execB);
    assert.ok(result);
    assert.equal(result.status, 'completed');

    // execA's lock should still be held
    const lock = readLock(project);
    assert.ok(lock);
    assert.equal(lock!.owner, execA, 'execA lock should still be held');
  } finally {
    try { releaseLock(project, execA, { force: true }); } catch {}
    cleanup();
  }
});
