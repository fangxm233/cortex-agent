// input:  Node test runner, assert, TaskRepo + TaskMutator
// output: tests for TaskRepo (concurrent add, state serialization, flush, end-to-end round-trip)
// pos:    verifies store/task-repo.ts Pattern B-lite guarantees (S3 migration)
// >>> If I am updated, update my header comment and CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { PROJECTS_DIR } from '../../src/core/paths.js';
import { TaskRepo, withGitLock } from '../../src/store/task-repo.js';
import { TaskMutator } from '../../src/domain/tasks/mutator.js';
import { writeLock, getOwnerIdentity } from '../../src/domain/tasks/system/task-lock.js';

// ── Fixture helpers ──────────────────────────────────────────────

const SEED_TASKS_YAML = () => `tasks:
  - id: aaaa
    text: "Seed task"
    why: "baseline"
    done-when: "exists"
    priority: medium
    status: open
    template: coder-review
    plan: ""
`;

const P = '_test_repo_';
let testCounter = 0;
function nextProject(): string { return `${P}${++testCounter}`; }

function makeFixtureRepo(projects?: string[]): {
  cleanup: () => void;
  tasksPathFor: (project: string) => string;
  projects: string[];
} {
  const projectNames = projects || [nextProject()];
  const backups = new Map<string, string | null>();
  for (const p of projectNames) {
    const dir = path.join(PROJECTS_DIR, p);
    fs.mkdirSync(dir, { recursive: true });
    const tasksPath = path.join(dir, 'TASKS.yaml');
    const backup = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : null;
    backups.set(p, backup);
    fs.writeFileSync(tasksPath, SEED_TASKS_YAML());
  }
  return {
    projects: projectNames,
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

// ── Test 1: runExclusive serializes concurrent callers (FIFO mutex) ──

test('runExclusive — N concurrent calls serialize in FIFO order', async () => {
  const repo = new TaskRepo({ skipGit: true });

  const results: string[] = [];
  const N = 10;

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      repo.runExclusive(() => {
        results.push(`op-${i}`);
        return `op-${i}`;
      })
    )
  );

  assert.equal(results.length, N, 'all N operations completed');
  for (let i = 0; i < N; i++) {
    assert.equal(results[i], `op-${i}`);
  }
});

// ── Test 2: Claim/complete state serialization ───────────────────

test('runExclusive — overlapping async ops stay serialized', async () => {
  const repo = new TaskRepo({ skipGit: true });

  const operations: string[] = [];

  const p1 = repo.runExclusive(() => {
    operations.push('start-claim');
    return new Promise(resolve => setTimeout(() => {
      operations.push('end-claim');
      resolve('claimed');
    }, 50));
  });

  const p2 = repo.runExclusive(() => {
    operations.push('start-complete');
    operations.push('end-complete');
    return 'completed';
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'claimed');
  assert.equal(r2, 'completed');
  assert.deepEqual(operations, ['start-claim', 'end-claim', 'start-complete', 'end-complete']);
});

// ── Test 3: Mid-mutate flush() resolves cleanly ──────────────────

test('flush() resolves after all enqueued mutations complete', async () => {
  const repo = new TaskRepo({ skipGit: true });

  const resolutionOrder: string[] = [];
  const N = 5;

  const mutations = Array.from({ length: N }, (_, i) =>
    repo.runExclusive(() => {
      resolutionOrder.push(`mut-${i}`);
      return `mut-${i}`;
    })
  );

  const flushDone = repo.flush().then(() => {
    resolutionOrder.push('flush');
  });

  await Promise.all([...mutations, flushDone]);

  assert.equal(resolutionOrder[N], 'flush',
    `flush must resolve last; got ${resolutionOrder.join(', ')}`);
});

// ── Test 4: withGitLock serializes across callers ────────────────

test('withGitLock serializes operations from different callers', async () => {
  const order: string[] = [];

  const a = withGitLock(() => {
    order.push('a-start');
    return new Promise(resolve => setTimeout(() => {
      order.push('a-end');
      resolve(1);
    }, 30));
  });

  const b = withGitLock(() => {
    order.push('b-start');
    order.push('b-end');
    return 2;
  });

  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, 1);
  assert.equal(rb, 2);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

// ── Test 5: flush() resolves immediately when idle ───────────────

test('flush() resolves immediately when no mutation is pending', async () => {
  const repo = new TaskRepo({ skipGit: true });
  const t0 = Date.now();
  await repo.flush();
  const dt = Date.now() - t0;
  assert.ok(dt < 50, `idle flush took ${dt}ms; expected near-instant`);
});

// ── End-to-end round-trip — add → load → getById → claim → complete ─────────

test('end-to-end — add → load → getById → claim → complete persists to TASKS.yaml', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = new TaskRepo({ skipGit: true });
    const mutator = new TaskMutator(repo);

    // 1) add a new task
    const addResult = await mutator.add(proj, 'New e2e task', 'why-e2e', 'done-e2e', 'medium', 'coder-review');
    assert.equal(addResult.success, true, `add failed: ${addResult.message}`);

    // 2) load and query — the new task must be findable by ID
    repo.load();
    const all = repo.getAll(proj);
    const added = all.find(t => t.text === 'New e2e task');
    assert.ok(added, 'added task must be visible after load');
    assert.ok(added.id, 'added task must have an auto-assigned id');

    const byId = repo.getById(added.id);
    assert.ok(byId, 'getById must return the added task');
    assert.equal(byId.text, 'New e2e task');

    // 3) claim (lifecycle mutation routed through mutator + mutex)
    const claimResult = await mutator.claim(added.id, 'test-agent');
    assert.equal(claimResult.success, true, `claim failed: ${claimResult.message}`);

    // Verify TASKS.yaml on disk reflects the claim
    const diskAfterClaim = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert.match(diskAfterClaim, /claimed-by:\s*test-agent/, 'TASKS.yaml must show claimed-by after claim');
    assert.equal(claimResult.agent, 'test-agent', 'claim result must record the claiming agent');

    // 4) complete
    const completeResult = await mutator.complete(added.id, 'e2e-note');
    assert.equal(completeResult.success, true, `complete failed: ${completeResult.message}`);

    const diskAfterComplete = fs.readFileSync(fx.tasksPathFor(proj), 'utf8');
    assert.match(diskAfterComplete, /status:\s*done/, 'completed task must have status: done');
    assert.match(diskAfterComplete, /text:\s*New e2e task/);
  } finally {
    fx.cleanup();
  }
});

// ── Test 8: End-to-end — concurrent add() does not lose tasks ────

test('end-to-end — 5 concurrent add() calls all persist via mutex serialization', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = new TaskRepo({ skipGit: true });
    const mutator = new TaskMutator(repo);

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutator.add(proj, `Concurrent task ${i}`, `why-${i}`, `done-${i}`, 'medium', 'coder-review')
      )
    );

    for (const r of results) {
      assert.equal(r.success, true, `add failed: ${r.message}`);
    }

    repo.load();
    const all = repo.getAll(proj);
    // Seed + N new tasks = N+1 total
    assert.equal(all.length, N + 1);
    for (let i = 0; i < N; i++) {
      assert.ok(all.some(t => t.text === `Concurrent task ${i}`), `missing: Concurrent task ${i}`);
    }
  } finally {
    fx.cleanup();
  }
});

// ── Test 9: Orphan sweep — pre-planted .tmp.* siblings are cleaned on first write ──

test('orphan sweep — pre-planted TASKS.yaml.tmp.* files removed on first write', async () => {
  const fx = makeFixtureRepo();
  const proj = fx.projects[0];
  try {
    const tasksPath = fx.tasksPathFor(proj);
    const dir = path.dirname(tasksPath);

    // Pre-plant orphan tmp files (simulate crashed atomicWrite from a previous process)
    fs.writeFileSync(path.join(dir, 'TASKS.yaml.tmp.99999.1000000'), 'stale-1');
    fs.writeFileSync(path.join(dir, 'TASKS.yaml.tmp.99998.2000000'), 'stale-2');
    assert.ok(fs.existsSync(path.join(dir, 'TASKS.yaml.tmp.99999.1000000')));
    assert.ok(fs.existsSync(path.join(dir, 'TASKS.yaml.tmp.99998.2000000')));

    const owner = getOwnerIdentity();
    writeLock(proj, { owner, acquired_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const repo = new TaskRepo({ skipGit: true });
    const mutator = new TaskMutator(repo);

    // First write triggers ensureSwept() which clears orphans for this tasksPath
    const r = await mutator.add(proj, 'trigger-sweep', 'w', 'd', 'medium', 'coder-review');
    assert.equal(r.success, true, `add failed: ${r.message}`);

    assert.ok(!fs.existsSync(path.join(dir, 'TASKS.yaml.tmp.99999.1000000')), 'orphan 1 should be swept');
    assert.ok(!fs.existsSync(path.join(dir, 'TASKS.yaml.tmp.99998.2000000')), 'orphan 2 should be swept');

    // The real TASKS.yaml must still be intact
    const content = fs.readFileSync(tasksPath, 'utf8');
    assert.match(content, /trigger-sweep/);
    assert.match(content, /Seed task/);
  } finally {
    fx.cleanup();
  }
});

// ── Test 10: commitAndPush is no-op when skipGit is true ──

test('commitAndPush — no-op when skipGit is true', async () => {
  const repo = new TaskRepo({ skipGit: true });
  // Should not throw despite no git repo existing
  repo.commitAndPush('should be ignored');
  assert.ok(true, 'commitAndPush with skipGit: true did not throw');
});
