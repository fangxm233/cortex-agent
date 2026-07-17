// input:  Node test runner, assert, TaskMutator + TaskRepo
// output: tests for TaskMutator (15 methods × happy/error = 30 cases)
// pos:    verifies domain/tasks/mutator.ts orchestrates mutations correctly
// >>> If I am updated, update my header comment and CORTEX.md <<<

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { TaskRepo } from '../../../src/store/task-repo.js';
import { TaskMutator } from '../../../src/domain/tasks/mutator.js';
import { writeLock, getOwnerIdentity } from '../../../src/domain/tasks/system/task-lock.js';

// ── Fixture helpers ──────────────────────────────────────────────

let taskIdCounter = 0;
function nextTaskId(): string {
  return `aaaa${++taskIdCounter}`;
}

function SEED_TASKS_YAML(taskId: string) {
  return `tasks:
  - id: ${taskId}
    text: "Seed task"
    why: "baseline"
    done-when: "exists"
    priority: medium
    status: open
    template: coder-review
    plan: ""
`;
}

const P = '_test_mutator_';
let testCounter = 0;
function nextProject(): string { return `${P}${++testCounter}`; }

function makeFixtureRepo(projects?: string[]): {
  cleanup: () => void;
  tasksPathFor: (project: string) => string;
  projects: string[];
  seedTaskId: string;
} {
  const projectNames = projects || [nextProject()];
  const seedTaskId = nextTaskId();
  const backups = new Map<string, string | null>();
  for (const p of projectNames) {
    const dir = path.join(PROJECTS_DIR, p);
    fs.mkdirSync(dir, { recursive: true });
    const tasksPath = path.join(dir, 'TASKS.yaml');
    const backup = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : null;
    backups.set(p, backup);
    fs.writeFileSync(tasksPath, SEED_TASKS_YAML(seedTaskId));
  }
  return {
    projects: projectNames,
    seedTaskId,
    cleanup: () => {
      for (const [p, backup] of backups) {
        const tasksPath = path.join(PROJECTS_DIR, p, 'TASKS.yaml');
        if (backup !== null) fs.writeFileSync(tasksPath, backup);
        else { try { fs.unlinkSync(tasksPath); } catch {} }
        try { fs.rmdirSync(path.join(PROJECTS_DIR, p)); } catch {}
      }
    },
    tasksPathFor: (project: string) =>
      path.join(PROJECTS_DIR, project, 'TASKS.yaml'),
  };
}

function createRepo(): TaskRepo {
  return new TaskRepo({ skipGit: true });
}

// ─── 1. claim ─────────────────────────────────────────────────────

test('claim — claims an unclaimed task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.claim(fx.seedTaskId, 'test-agent');
    assert.equal(result.success, true);
    assert.equal(result.agent, 'test-agent');
    const disk = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert.match(disk, /claimed-by:\s*test-agent/);
    assert.match(disk, /claimed-at:\s*"?\d{4}-\d{2}-\d{2}"?/);
  } finally {
    fx.cleanup();
  }
});

test('claim — fails when task is already claimed', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.claim(fx.seedTaskId, 'agent-1');
    const result = await mutator.claim(fx.seedTaskId, 'agent-2');
    assert.equal(result.success, false);
    assert.match(result.message, /already claimed/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 2. unclaim ───────────────────────────────────────────────────

test('unclaim — unclaims a claimed task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.claim(fx.seedTaskId, 'agent');
    const result = await mutator.unclaim(fx.seedTaskId);
    assert.equal(result.success, true);
    assert.doesNotMatch(
      fs.readFileSync(fx.tasksPathFor(proj), 'utf8'),
      /claimed-by:/,
    );
  } finally {
    fx.cleanup();
  }
});

test('unclaim — fails when task is not in-progress', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.unclaim(fx.seedTaskId);
    assert.equal(result.success, false);
    assert.match(result.message, /not in-progress/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 3. complete ──────────────────────────────────────────────────

test('complete — completes a claimed task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.claim(fx.seedTaskId, 'agent');
    const result = await mutator.complete(fx.seedTaskId, 'test-note');
    assert.equal(result.success, true, `complete failed: ${result.message}`);

    const disk = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert.match(disk, /status:\s*done/);
    assert.match(disk, /text:\s*"?Seed task/);
  } finally {
    fx.cleanup();
  }
});

test('complete — fails for nonexistent task', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.complete('zzzz');
    assert.equal(result.success, false);
    assert.match(result.message, /not found/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 4. uncomplete ────────────────────────────────────────────────

test('uncomplete — reverts a completed task to open', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.claim(fx.seedTaskId, 'agent');
    await mutator.complete(fx.seedTaskId, 'done');
    const result = await mutator.uncomplete(fx.seedTaskId);
    assert.equal(result.success, true);
    const disk = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert.match(disk, /status:\s*open/);
  } finally {
    fx.cleanup();
  }
});

test('uncomplete — fails when task is not completed', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.uncomplete(fx.seedTaskId);
    assert.equal(result.success, false);
    assert.match(result.message, /not completed/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 5. block ─────────────────────────────────────────────────────

test('block — blocks an open task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.block(fx.seedTaskId, 'waiting-for-dep');
    assert.equal(result.success, true);
    assert.match(
      fs.readFileSync(fx.tasksPathFor(proj), 'utf8'),
      /blocked-by:\s*waiting-for-dep/,
    );
  } finally {
    fx.cleanup();
  }
});

test('block — fails for nonexistent task', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.block('zzzz', 'reason');
    assert.equal(result.success, false);
    assert.match(result.message, /not found/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 6. unblock ───────────────────────────────────────────────────

test('unblock — unblocks a blocked task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.block(fx.seedTaskId, 'blocker');
    const result = await mutator.unblock(fx.seedTaskId);
    assert.equal(result.success, true);
    assert.doesNotMatch(
      fs.readFileSync(fx.tasksPathFor(proj), 'utf8'),
      /blocked-by:/,
    );
  } finally {
    fx.cleanup();
  }
});

test('unblock — fails for nonexistent task', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.unblock('zzzz');
    assert.equal(result.success, false);
    assert.match(result.message, /not found/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 7. pause ─────────────────────────────────────────────────────

test('pause — pauses a claimed task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.claim(fx.seedTaskId, 'agent');
    const result = await mutator.pause(fx.seedTaskId);
    assert.equal(result.success, true);
    assert.match(
      fs.readFileSync(fx.tasksPathFor(proj), 'utf8'),
      /paused:\s*true/,
    );
  } finally {
    fx.cleanup();
  }
});

test('pause — fails when task is already paused', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.claim(fx.seedTaskId, 'agent');
    await mutator.pause(fx.seedTaskId);
    const result = await mutator.pause(fx.seedTaskId);
    assert.equal(result.success, false);
    assert.match(result.message, /already paused/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 8. resume ────────────────────────────────────────────────────

test('resume — resumes a paused task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.claim(fx.seedTaskId, 'agent');
    await mutator.pause(fx.seedTaskId);
    const result = await mutator.resume(fx.seedTaskId);
    assert.equal(result.success, true);
    assert.doesNotMatch(
      fs.readFileSync(fx.tasksPathFor(proj), 'utf8'),
      /paused:\s*true/,
    );
  } finally {
    fx.cleanup();
  }
});

test('resume — fails when task is not paused', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.resume(fx.seedTaskId);
    assert.equal(result.success, false);
    assert.match(result.message, /not paused/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 9. requestApproval ───────────────────────────────────────────

test('requestApproval — marks a task as approval-needed', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.requestApproval(fx.seedTaskId);
    assert.equal(result.success, true);
    assert.match(
      fs.readFileSync(fx.tasksPathFor(proj), 'utf8'),
      /approval-needed:\s*true/,
    );
  } finally {
    fx.cleanup();
  }
});

test('requestApproval — fails when task already requires approval', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.requestApproval(fx.seedTaskId);
    const result = await mutator.requestApproval(fx.seedTaskId);
    assert.equal(result.success, false);
    assert.match(result.message, /already requires approval/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 10. approve ─────────────────────────────────────────────────

test('approve — approves a task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.requestApproval(fx.seedTaskId);
    const result = await mutator.approve(fx.seedTaskId);
    assert.equal(result.success, true);
    assert.match(
      fs.readFileSync(fx.tasksPathFor(proj), 'utf8'),
      /approved-at:\s*"?\d{4}-\d{2}-\d{2}"?/,
    );
  } finally {
    fx.cleanup();
  }
});

test('approve — fails for nonexistent task', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.approve('zzzz');
    assert.equal(result.success, false);
    assert.match(result.message, /not found/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 11. clearApproval ───────────────────────────────────────────

test('clearApproval — clears approval tags from a task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.requestApproval(fx.seedTaskId);
    await mutator.approve(fx.seedTaskId);
    const result = await mutator.clearApproval(fx.seedTaskId);
    assert.equal(result.success, true);
    const disk = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert.doesNotMatch(disk, /approval-needed:\s*true/);
    assert.doesNotMatch(disk, /approved-at:/);
  } finally {
    fx.cleanup();
  }
});

test('clearApproval — fails when task has no approval tags', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.clearApproval(fx.seedTaskId);
    assert.equal(result.success, false);
    assert.match(result.message, /no approval tags/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 12. batchEdit ───────────────────────────────────────────────

test('batchEdit — edits multiple tasks in a project', async () => {
  const proj = nextProject();
  const fx = makeFixtureRepo([proj]);
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const r1 = await mutator.add(proj, 'Batch A', 'test', 'exists', 'low', 'coder-review');
    const r2 = await mutator.add(proj, 'Batch B', 'test', 'exists', 'low', 'coder-review');
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);

    const result = await mutator.batchEdit(proj, [r1.task_id, r2.task_id], { priority: 'high' });
    assert.equal(result.success, true);
    assert.match(result.message, /2\/2 tasks updated/);

    const disk = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert(disk.includes('priority: high'));
  } finally {
    fx.cleanup();
  }
});

test('batchEdit — fails when none of the task IDs exist', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.batchEdit(proj, ['zzzz', 'yyyy'], { priority: 'high' });
    assert.equal(result.success, false);
    assert(result.results);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].success, false);
  } finally {
    fx.cleanup();
  }
});

// ─── 13. add ─────────────────────────────────────────────────────

test('add — adds a new task to the project', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.add(
      proj, 'New task', 'the why', 'the done-when',
      'high', 'coder-review',
    );
    assert.equal(result.success, true);
    assert.ok(result.task_id);
    assert.match(result.task_id, /^[0-9a-f]{4}$/);

    const disk = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert.match(disk, /text:\s*New task/);
    assert.match(disk, /why:\s*the why/);
    assert.match(disk, /done-when:\s*the done-when/);
    assert.match(disk, /priority:\s*high/);
  } finally {
    fx.cleanup();
  }
});

test('add — fails with empty text', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.add(
      proj, '', 'why', 'done-when', 'medium', 'coder-review',
    );
    assert.equal(result.success, false);
    assert.match(result.message, /required/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 14. edit ────────────────────────────────────────────────────

test('edit — edits a task priority', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.edit(proj, { taskId: fx.seedTaskId, priority: 'high' });
    assert.equal(result.success, true);
    assert.match(
      fs.readFileSync(fx.tasksPathFor(proj), 'utf8'),
      /priority:\s*high/,
    );
  } finally {
    fx.cleanup();
  }
});

test('edit — fails with invalid priority', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.edit(proj, { taskId: fx.seedTaskId, priority: 'wrong' });
    assert.equal(result.success, false);
    assert.match(result.message, /invalid priority/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 15. decompose ───────────────────────────────────────────────

test('decompose — splits a task into subtasks', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const subtasks = [
      { text: 'Subtask 1', why: 'part-one', done_when: 'done1', priority: 'high' },
      { text: 'Subtask 2', why: 'part-two', done_when: 'done2', priority: 'medium' },
    ];
    const result = await mutator.decompose(proj, 'Seed task', subtasks, fx.seedTaskId);
    assert.equal(result.success, true);
    assert.match(result.message, /decomposed into 2 subtasks/);

    const disk = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert.match(disk, /text:\s*Subtask 1/);
    assert.match(disk, /text:\s*Subtask 2/);
    assert.doesNotMatch(disk, /text:\s*"?Seed task/); // original replaced
  } finally {
    fx.cleanup();
  }
});

test('decompose — fails for nonexistent task', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.decompose(proj, 'Nothing here', [], 'zzzz');
    assert.equal(result.success, false);
    assert.match(result.message, /not found/i);
  } finally {
    fx.cleanup();
  }
});

// ─── 16. EventBus publication — claim ─────────────────────────────

test('claim — publishes task.claimed event when bus is wired', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const published: any[] = [];
    const mockBus = { publish: (e: any) => { published.push(e); }, subscribe: () => ({ unsubscribe: () => {} }) };
    const mutator = new TaskMutator(repo, mockBus as any);
    const result = await mutator.claim(fx.seedTaskId, 'test-agent');
    assert.equal(result.success, true);

    assert.equal(published.length, 1);
    assert.equal(published[0].type, 'task.claimed');
    assert.equal(published[0].taskId, fx.seedTaskId);
    assert.equal(published[0].by, 'test-agent');
    // ts is injected by EventBus.publish() — not the mutator's job
    assert.equal('ts' in published[0], false);
  } finally {
    fx.cleanup();
  }
});

test('claim — does not publish when bus is not wired', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    // Backward compat: mutator works without a bus
    const result = await mutator.claim(fx.seedTaskId, 'test-agent');
    assert.equal(result.success, true);
  } finally {
    fx.cleanup();
  }
});

// ─── 17. EventBus publication — complete ──────────────────────────

test('complete — publishes task.completed event when bus is wired', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const published: any[] = [];
    const mockBus = { publish: (e: any) => { published.push(e); }, subscribe: () => ({ unsubscribe: () => {} }) };
    const mutator = new TaskMutator(repo, mockBus as any);
    await mutator.claim(fx.seedTaskId, 'agent');
    published.length = 0; // clear claim event

    const result = await mutator.complete(fx.seedTaskId, 'test-note');
    assert.equal(result.success, true);

    assert.equal(published.length, 1);
    assert.equal(published[0].type, 'task.completed');
    assert.equal(published[0].taskId, fx.seedTaskId);
    assert.equal('ts' in published[0], false);
  } finally {
    fx.cleanup();
  }
});

test('complete — does not publish when bus is not wired', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    await mutator.claim(fx.seedTaskId, 'agent');
    const result = await mutator.complete(fx.seedTaskId, 'test-note');
    assert.equal(result.success, true);
    // No crash — backward compat
  } finally {
    fx.cleanup();
  }
});

// ─── 17b. EventBus publication — unclaim ──────────────────────────

test('unclaim — publishes task.unclaimed event when bus is wired', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const published: any[] = [];
    const mockBus = { publish: (e: any) => { published.push(e); }, subscribe: () => ({ unsubscribe: () => {} }) };
    const mutator = new TaskMutator(repo, mockBus as any);
    await mutator.claim(fx.seedTaskId, 'agent');
    published.length = 0; // clear claim event

    const result = await mutator.unclaim(fx.seedTaskId);
    assert.equal(result.success, true);

    assert.equal(published.length, 1);
    assert.equal(published[0].type, 'task.unclaimed');
    assert.equal(published[0].taskId, fx.seedTaskId);
    assert.equal('ts' in published[0], false);
  } finally {
    fx.cleanup();
  }
});

test('unclaim — does not publish on failure', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const published: any[] = [];
    const mockBus = { publish: (e: any) => { published.push(e); }, subscribe: () => ({ unsubscribe: () => {} }) };
    const mutator = new TaskMutator(repo, mockBus as any);
    // seed task is not in-progress → unclaim fails, no event
    const result = await mutator.unclaim(fx.seedTaskId);
    assert.equal(result.success, false);
    assert.equal(published.length, 0);
  } finally {
    fx.cleanup();
  }
});

// ─── 17c. EventBus publication — unblock ──────────────────────────

test('unblock — publishes task.unblocked event when bus is wired', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const published: any[] = [];
    const mockBus = { publish: (e: any) => { published.push(e); }, subscribe: () => ({ unsubscribe: () => {} }) };
    const mutator = new TaskMutator(repo, mockBus as any);
    await mutator.block(fx.seedTaskId, 'blocker');
    published.length = 0; // clear block event

    const result = await mutator.unblock(fx.seedTaskId);
    assert.equal(result.success, true);

    assert.equal(published.length, 1);
    assert.equal(published[0].type, 'task.unblocked');
    assert.equal(published[0].taskId, fx.seedTaskId);
    assert.equal('ts' in published[0], false);
  } finally {
    fx.cleanup();
  }
});

test('unblock — does not publish on failure', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const published: any[] = [];
    const mockBus = { publish: (e: any) => { published.push(e); }, subscribe: () => ({ unsubscribe: () => {} }) };
    const mutator = new TaskMutator(repo, mockBus as any);
    // nonexistent task → unblock fails, no event (unblock is idempotent for existing tasks)
    const result = await mutator.unblock('zzzz');
    assert.equal(result.success, false);
    assert.equal(published.length, 0);
  } finally {
    fx.cleanup();
  }
});

// ─── 18. EventBus publication — setBus wiring ─────────────────────

test('setBus — wires event bus after construction', async () => {
  const fx = makeFixtureRepo();
  try {
    const repo = createRepo();
    const published: any[] = [];
    const mockBus = { publish: (e: any) => { published.push(e); }, subscribe: () => ({ unsubscribe: () => {} }) };
    const mutator = new TaskMutator(repo);
    mutator.setBus(mockBus as any);

    await mutator.claim(fx.seedTaskId, 'test-agent');
    assert.equal(published.length, 1);
    assert.equal(published[0].type, 'task.claimed');
  } finally {
    fx.cleanup();
  }
});

// --- 19. Lock-required: add ---

test('add \xe2\x80\x94 fails without lock held', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.add(proj, 'No lock task', 'why', 'done-when', 'high', 'coder-review');
    assert.equal(result.success, false);
    assert.match(result.message, /lock/i);
  } finally {
    fx.cleanup();
  }
});

test('add \xe2\x80\x94 succeeds when lock held by current owner', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, {
      owner,
      acquired_at: new Date().toISOString(),
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.add(proj, 'Locked add', 'why', 'done-when', 'high', 'coder-review');
    assert.equal(result.success, true);
    assert.ok(result.task_id);
  } finally {
    fx.cleanup();
  }
});

// --- 17. Lock-required: edit ---

test('edit \xe2\x80\x94 fails without lock held', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.edit(proj, { taskId: fx.seedTaskId, text: 'edited' });
    assert.equal(result.success, false);
    assert.match(result.message, /lock/i);
  } finally {
    fx.cleanup();
  }
});

test('edit \xe2\x80\x94 succeeds when lock held by current owner', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, {
      owner,
      acquired_at: new Date().toISOString(),
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.edit(proj, { taskId: fx.seedTaskId, priority: 'high' });
    assert.equal(result.success, true);
  } finally {
    fx.cleanup();
  }
});

// --- 18. Lock-required: batchEdit ---

test('batchEdit \xe2\x80\x94 fails without lock held', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.batchEdit(proj, [fx.seedTaskId], { priority: 'high' });
    assert.equal(result.success, false);
    assert.match(result.message, /lock/i);
  } finally {
    fx.cleanup();
  }
});

// --- 19. Lock-required: decompose ---

test('decompose \xe2\x80\x94 fails without lock held', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const repo = createRepo();
    const mutator = new TaskMutator(repo);
    const result = await mutator.decompose(proj, 'Seed task', [{ text: 'X', why: 'y', done_when: 'z', priority: 'high' }], fx.seedTaskId);
    assert.equal(result.success, false);
    assert.match(result.message, /lock/i);
  } finally {
    fx.cleanup();
  }
});

// --- 20. Other project lock scoping ---

test('other project lock does not affect current project operation', async () => {
  const projA = nextProject();
  const projB = nextProject();
  const fx = makeFixtureRepo([projA, projB]);
  try {
    // Acquire lock on A for current owner
    const owner = getOwnerIdentity();
    writeLock(projA, {
      owner,
      acquired_at: new Date().toISOString(),
      expires_at: '2099-01-01T00:00:00.000Z',
    });

    // Write lock on B with a different owner
    writeLock(projB, {
      owner: 'other-owner',
      acquired_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    });

    const repo = createRepo();
    const mutator = new TaskMutator(repo);

    // Operation on A should succeed (lock held by us)
    const resultA = await mutator.add(projA, 'Task on A', 'why', 'done-when', 'high', 'coder-review');
    assert.equal(resultA.success, true, 'add on project A should succeed when lock held');

    // Operation on B should FAIL (lock held by different owner)
    const resultB = await mutator.add(projB, 'Task on B', 'why', 'done-when', 'high', 'coder-review');
    assert.equal(resultB.success, false, 'add on project B should fail when lock held by different owner');
    assert.match(resultB.message, /lock/i);
  } finally {
    fx.cleanup();
  }
});
