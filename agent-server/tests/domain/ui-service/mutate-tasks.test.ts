import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { acquireLock, releaseLock, readLock, getOwnerIdentity } from '../../../src/domain/tasks/system/task-lock.js';

const TEST_PROJECT = '_ui_mutate_tasks_test';

beforeAll(() => {
  const dir = path.join(PROJECTS_DIR, TEST_PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const tasksPath = path.join(dir, 'TASKS.yaml');
  if (!fs.existsSync(tasksPath)) {
    fs.writeFileSync(tasksPath, `tasks:
  - id: tt1
    text: "Mutate test task"
    why: "testing"
    done-when: ""
    priority: medium
    status: open
    template: coder-review
    plan: ""
`, 'utf8');
  }
});

afterAll(() => {
  const dir = path.join(PROJECTS_DIR, TEST_PROJECT);
  try {
    const tasksPath = path.join(dir, 'TASKS.yaml');
    if (fs.existsSync(tasksPath)) fs.unlinkSync(tasksPath);
    // Remove .tmp files too
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('TASKS.yaml.tmp')) {
        fs.unlinkSync(path.join(dir, entry));
      }
    }
    fs.rmdirSync(dir);
  } catch {}
});

test('tasks.lock acquire and release cycle works', () => {
  const owner = getOwnerIdentity();
  const acq = acquireLock(TEST_PROJECT, { owner });
  assert.equal(acq.acquired, true);

  const lock = readLock(TEST_PROJECT);
  assert.equal(lock?.owner, owner);

  const rel = releaseLock(TEST_PROJECT, owner);
  assert.equal(rel.released, true);
});

test('tasks.lock second acquire fails when held', () => {
  const owner1 = 'test-agent-1';
  const owner2 = 'test-agent-2';

  const acq1 = acquireLock(TEST_PROJECT, { owner: owner1 });
  assert.equal(acq1.acquired, true);

  const acq2 = acquireLock(TEST_PROJECT, { owner: owner2 });
  assert.equal(acq2.acquired, false);
  if (!acq2.acquired) {
    assert.ok(acq2.message!.includes('Lock held by'));
  }

  releaseLock(TEST_PROJECT, owner1);
});

test('tasks.lock force acquire overrides existing lock', () => {
  acquireLock(TEST_PROJECT, { owner: 'original-owner' });
  const acq2 = acquireLock(TEST_PROJECT, { owner: 'new-owner', force: true });
  assert.equal(acq2.acquired, true);

  // cleanup
  releaseLock(TEST_PROJECT, 'new-owner');
});
