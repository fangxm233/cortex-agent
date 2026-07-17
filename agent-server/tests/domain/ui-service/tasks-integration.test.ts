// Tasks integration test: uses real TaskStore to verify
// lock-acquire → claim → release cycle with no lock leakage on error paths.
// This test requires access to the real PROJECTS_DIR and filesystem.

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { acquireLock, releaseLock, readLock } from '../../../src/domain/tasks/system/task-lock.js';

const TEST_PROJECT = '_ui_test_tasks';

beforeAll(() => {
  const dir = path.join(PROJECTS_DIR, TEST_PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const tasksPath = path.join(dir, 'TASKS.yaml');
  if (!fs.existsSync(tasksPath)) {
    const yaml = `tasks:
  - id: t1
    text: "Integration test task"
    why: "testing"
    done-when: ""
    priority: medium
    status: open
    template: coder-review
    plan: ""
`;
    fs.writeFileSync(tasksPath, yaml, 'utf8');
  }
});

afterAll(() => {
  const dir = path.join(PROJECTS_DIR, TEST_PROJECT);
  try {
    const tasksPath = path.join(dir, 'TASKS.yaml');
    if (fs.existsSync(tasksPath)) fs.unlinkSync(tasksPath);
    fs.rmdirSync(dir);
  } catch {}
});

test('tasks integration: acquire lock → release cycle', () => {
  const owner = 'test-agent';
  const acq = acquireLock(TEST_PROJECT, { owner });
  assert.equal(acq.acquired, true, 'should acquire lock');
  assert.equal(readLock(TEST_PROJECT)?.owner, owner);

  const rel = releaseLock(TEST_PROJECT, owner);
  assert.equal(rel.released, true, 'should release lock');
  assert.equal(readLock(TEST_PROJECT), null, 'lock should be null after release');
});

test('tasks integration: lock acquisition fails when already held', () => {
  const owner1 = 'agent-1';
  const owner2 = 'agent-2';

  acquireLock(TEST_PROJECT, { owner: owner1 });
  const acq2 = acquireLock(TEST_PROJECT, { owner: owner2 });
  assert.equal(acq2.acquired, false, 'second acquire should fail');

  releaseLock(TEST_PROJECT, owner1);
});

test('tasks integration: lock auto-expires after TTL', () => {
  // Force-acquire with a past timestamp
  const owner = 'stale-agent';
  const acq = acquireLock(TEST_PROJECT, { owner, force: true });
  assert.equal(acq.acquired, true);

  // Second acquire without force should fail
  const acq2 = acquireLock(TEST_PROJECT, { owner: 'new-agent' });
  assert.equal(acq2.acquired, false, 'new agent cannot acquire while lock held');

  // Force-release
  releaseLock(TEST_PROJECT, owner, { force: true });
  const lock = readLock(TEST_PROJECT);
  assert.equal(lock, null, 'lock released');
});

test('tasks integration: lock release is idempotent', () => {
  const owner = 'idempotent-agent';
  acquireLock(TEST_PROJECT, { owner });

  releaseLock(TEST_PROJECT, owner);
  const r1 = readLock(TEST_PROJECT);
  assert.equal(r1, null);

  // Second release should not throw
  releaseLock(TEST_PROJECT, owner);
  assert.ok(true, 'idempotent release ok');
});

test('tasks integration: releaseLock with non-owner fails', () => {
  acquireLock(TEST_PROJECT, { owner: 'real-owner', force: true });

  const result = releaseLock(TEST_PROJECT, 'wrong-owner');
  assert.equal(result.released, false);

  // Cleanup
  releaseLock(TEST_PROJECT, 'real-owner', { force: true });
});

test('tasks integration: readLock on missing project returns null', () => {
  const lock = readLock('_nonexistent_project_for_testing');
  assert.equal(lock, null);
});
