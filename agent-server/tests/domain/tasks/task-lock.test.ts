// input:  Node test runner, assert, task-lock primitives
// output: tests for acquireLock / releaseLock / readLock / writeLock / assertLockHeld / isProjectLocked / getOwnerIdentity
// pos:    verifies domain/tasks/system/task-lock.ts lock lifecycle + edge cases
// >>> If I am updated, update my header comment and CORTEX.md <<<

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../../../src/core/paths.js';
import {
  acquireLock,
  releaseLock,
  readLock,
  writeLock,
  assertLockHeld,
  isProjectLocked,
  getOwnerIdentity,
} from '../../../src/domain/tasks/system/task-lock.js';

// ── Fixture helpers ──────────────────────────────────────────────

const P = '_test_task_lock_';
let counter = 0;
function nextProject(): string { return `${P}${++counter}`; }

function setupProject(project: string): void {
  const dir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASKS.yaml'), 'tasks: []\n');
}

function cleanupProject(project: string): void {
  try { fs.unlinkSync(path.join(PROJECTS_DIR, project, 'TASKS.yaml')); } catch {}
  try { fs.rmdirSync(path.join(PROJECTS_DIR, project)); } catch {}
}

// ─── 1. acquireLock ──────────────────────────────────────────────

test('acquire — acquires a lock with default TTL', () => {
  const project = nextProject();
  setupProject(project);
  try {
    const result = acquireLock(project, { owner: 'owner-A' });
    assert.equal(result.acquired, true);
    assert.ok(result.lock);
    assert.equal(result.lock!.owner, 'owner-A');
    assert.ok(result.lock!.acquired_at);
    assert.ok(result.lock!.expires_at);

    // Verify lock is persisted to disk
    const stored = readLock(project);
    assert.ok(stored);
    assert.equal(stored!.owner, 'owner-A');
  } finally {
    cleanupProject(project);
  }
});

test('acquire — fails when lock held by different owner and not expired', () => {
  const project = nextProject();
  setupProject(project);
  try {
    acquireLock(project, { owner: 'owner-A' });
    const result = acquireLock(project, { owner: 'owner-B' });
    assert.equal(result.acquired, false);
    assert.match(result.message!, /Lock held by/i);
    assert.equal(result.lock!.owner, 'owner-A');
  } finally {
    cleanupProject(project);
  }
});

test('acquire — force overrides existing valid lock', () => {
  const project = nextProject();
  setupProject(project);
  try {
    acquireLock(project, { owner: 'owner-A' });
    const result = acquireLock(project, { owner: 'owner-B', force: true });
    assert.equal(result.acquired, true);
    assert.ok(result.lock);
    assert.equal(result.lock!.owner, 'owner-B');
  } finally {
    cleanupProject(project);
  }
});

test('acquire — expired lock can be acquired without force', () => {
  const project = nextProject();
  setupProject(project);
  try {
    // Write a lock that expired long ago
    writeLock(project, {
      owner: 'old-owner',
      acquired_at: '2020-01-01T00:00:00.000Z',
      expires_at: '2020-06-01T00:00:00.000Z',
    });
    const result = acquireLock(project, { owner: 'new-owner' });
    assert.equal(result.acquired, true);
    assert.equal(result.lock!.owner, 'new-owner');
  } finally {
    cleanupProject(project);
  }
});

// ─── 2. releaseLock ─────────────────────────────────────────────

test('release — releases lock held by same owner', () => {
  const project = nextProject();
  setupProject(project);
  try {
    acquireLock(project, { owner: 'owner-A' });
    const result = releaseLock(project, 'owner-A');
    assert.equal(result.released, true);
    assert.equal(readLock(project), null);
  } finally {
    cleanupProject(project);
  }
});

test('release — fails when lock held by different owner', () => {
  const project = nextProject();
  setupProject(project);
  try {
    acquireLock(project, { owner: 'owner-A' });
    const result = releaseLock(project, 'owner-B');
    assert.equal(result.released, false);
    assert.match(result.message!, /different owner/i);
    // Lock should still be intact
    assert.equal(readLock(project)!.owner, 'owner-A');
  } finally {
    cleanupProject(project);
  }
});

test('release — force releases across different owner', () => {
  const project = nextProject();
  setupProject(project);
  try {
    acquireLock(project, { owner: 'owner-A' });
    const result = releaseLock(project, 'owner-B', { force: true });
    assert.equal(result.released, true);
    assert.equal(readLock(project), null);
  } finally {
    cleanupProject(project);
  }
});

test('release — returns success when no lock held', () => {
  const project = nextProject();
  setupProject(project);
  try {
    const result = releaseLock(project, 'anyone');
    assert.equal(result.released, true);
    assert.match(result.message!, /No lock/i);
  } finally {
    cleanupProject(project);
  }
});

// ─── 3. isProjectLocked ─────────────────────────────────────────

test('isProjectLocked — returns locked state for active lock', () => {
  const project = nextProject();
  setupProject(project);
  try {
    writeLock(project, {
      owner: 'owner-A',
      acquired_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    const result = isProjectLocked(project, '2026-06-01T00:00:00.000Z');
    assert.equal(result.locked, true);
    assert.equal(result.owner, 'owner-A');
    assert.ok(result.expiresAt);
  } finally {
    cleanupProject(project);
  }
});

test('isProjectLocked — returns unlocked when no lock exists', () => {
  const project = nextProject();
  setupProject(project);
  try {
    const result = isProjectLocked(project);
    assert.equal(result.locked, false);
    assert.equal(result.owner, undefined);
  } finally {
    cleanupProject(project);
  }
});

test('isProjectLocked — returns unlocked when lock expired', () => {
  const project = nextProject();
  setupProject(project);
  try {
    writeLock(project, {
      owner: 'owner-A',
      acquired_at: '2020-01-01T00:00:00.000Z',
      expires_at: '2020-06-01T00:00:00.000Z',
    });
    const result = isProjectLocked(project, '2026-01-01T00:00:00.000Z');
    assert.equal(result.locked, false);
  } finally {
    cleanupProject(project);
  }
});

// ─── 4. assertLockHeld ──────────────────────────────────────────

test('assertLockHeld — returns null when lock held by correct owner', () => {
  const project = nextProject();
  setupProject(project);
  try {
    writeLock(project, {
      owner: 'owner-A',
      acquired_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(assertLockHeld(project, 'owner-A'), null);
  } finally {
    cleanupProject(project);
  }
});

test('assertLockHeld — returns error when no lock exists', () => {
  const project = nextProject();
  setupProject(project);
  try {
    const err = assertLockHeld(project, 'anyone');
    assert.ok(err);
    assert.match(err!, /No lock/i);
  } finally {
    cleanupProject(project);
  }
});

test('assertLockHeld — returns error when lock expired', () => {
  const project = nextProject();
  setupProject(project);
  try {
    writeLock(project, {
      owner: 'owner-A',
      acquired_at: '2020-01-01T00:00:00.000Z',
      expires_at: '2020-06-01T00:00:00.000Z',
    });
    const err = assertLockHeld(project, 'owner-A');
    assert.ok(err);
    assert.match(err!, /expired/i);
  } finally {
    cleanupProject(project);
  }
});

test('assertLockHeld — returns error when owner differs', () => {
  const project = nextProject();
  setupProject(project);
  try {
    writeLock(project, {
      owner: 'owner-A',
      acquired_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    const err = assertLockHeld(project, 'owner-B');
    assert.ok(err);
    assert.match(err!, /different owner/i);
  } finally {
    cleanupProject(project);
  }
});

// ─── 5. writeLock / readLock ────────────────────────────────────

test('writeLock — clearing lock removes lock fields and preserves tasks', () => {
  const project = nextProject();
  setupProject(project);
  try {
    writeLock(project, {
      owner: 'owner-A',
      acquired_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    assert.ok(readLock(project));

    // Clear lock
    writeLock(project, null);
    assert.equal(readLock(project), null);

    // Verify tasks content preserved
    const content = fs.readFileSync(path.join(PROJECTS_DIR, project, 'TASKS.yaml'), 'utf8');
    assert.match(content, /tasks:/);
  } finally {
    cleanupProject(project);
  }
});

test('readLock — returns null for nonexistent project', () => {
  assert.equal(readLock('__nonexistent_project_xyz__'), null);
});

test('readLock — returns null for project without TASKS.yaml', () => {
  const project = nextProject();
  const dir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.equal(readLock(project), null);
  } finally {
    try { fs.rmdirSync(dir); } catch {}
  }
});

test('readLock — returns lock from disk with all fields', () => {
  const project = nextProject();
  setupProject(project);
  try {
    writeLock(project, {
      owner: 'own1',
      acquired_at: '2026-05-01T00:00:00.000Z',
      expires_at: '2026-05-02T00:00:00.000Z',
      note: 'test note',
    });
    const lock = readLock(project);
    assert.ok(lock);
    assert.equal(lock!.owner, 'own1');
    assert.equal(lock!.acquired_at, '2026-05-01T00:00:00.000Z');
    assert.equal(lock!.expires_at, '2026-05-02T00:00:00.000Z');
    assert.equal(lock!.note, 'test note');
  } finally {
    cleanupProject(project);
  }
});

// ─── 6. getOwnerIdentity ────────────────────────────────────────

test('getOwnerIdentity — returns CORTEX_EXECUTION_ID when set', () => {
  const prev = process.env.CORTEX_EXECUTION_ID;
  try {
    process.env.CORTEX_EXECUTION_ID = 'test-exec-123';
    assert.equal(getOwnerIdentity(), 'test-exec-123');
  } finally {
    process.env.CORTEX_EXECUTION_ID = prev;
  }
});

test('getOwnerIdentity — returns manual:<user>:<pid> fallback', () => {
  const prev = process.env.CORTEX_EXECUTION_ID;
  try {
    delete process.env.CORTEX_EXECUTION_ID;
    const id = getOwnerIdentity();
    assert.match(id, /^manual:\w+:\d+$/);
  } finally {
    process.env.CORTEX_EXECUTION_ID = prev;
  }
});
