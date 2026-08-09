// input:  Vitest, the three Gate-5 task ports and their shipped extraction targets
// output: P2 git severance (by effect, not by flag), P4 trial lock ownership + spin bound,
//         P5 trial-root artifact projection, and the three daemon-path regression pins
// pos:    §7.2 P2/P4/P5 — the ports that decide whether an in-trial mutation can touch host
//         state: the git remote, the host lock table and the host artifact root
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const gitProcess = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

// The assertion target of done-when (1): no `git add`, no `git commit` and no `git push`
// subprocess may be created by a trial-scoped mutation. Mocked at the module boundary so the
// assertion is on subprocess creation (exec/spawn observation), never on a flag or a message.
vi.mock('node:child_process', () => ({
  execSync: gitProcess.execSync,
  execFileSync: gitProcess.execFileSync,
  spawn: gitProcess.spawn,
}));

import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { managerNodeDir, taskArtifactPath, ensureTaskArtifact } from '../../../src/core/task-node.js';
import { TaskRepo } from '../../../src/store/task-repo.js';
import { TaskMutator } from '../../../src/domain/tasks/mutator.js';
import { mintActorCapability } from '../../../src/domain/benchmark/capabilities.js';
import {
  acquireLock,
  assertLockHeld,
  getOwnerIdentity,
  isProjectLocked,
  readLock,
  releaseLock,
  writeLock,
  TrialLockContendedError,
} from '../../../src/domain/tasks/system/task-lock.js';
import {
  createTaskArtifactProjection,
  createTrialTaskLockTable,
  createTrialTaskLocks,
  createTrialTaskRepository,
} from '../../../src/domain/benchmark/trial-task-ports.js';
import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';
import { PolicyCompilationError } from '../../../src/domain/benchmark/resolved-policy.js';
import { recordProposal } from '../../../src/domain/benchmark/proposal-seal.js';
// The wiring half of done-when (1): the factories must be reachable through the frozen ports
// module, which is the production interface a coordinator builds from (§4.2 N-1).
import {
  createTaskArtifactProjection as wiredArtifacts,
  createTrialTaskLocks as wiredLocks,
  createTrialTaskRepository as wiredRepository,
  withTrialTaskArtifactScope,
  withTrialTaskLockScope,
} from '../../../src/domain/benchmark/composite-runtime-ports.js';

beforeEach(() => {
  gitProcess.execSync.mockReset();
  gitProcess.execFileSync.mockReset();
  gitProcess.spawn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Fixture helpers ──────────────────────────────────────────────

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

const P = '_test_trial_ports_';
let testCounter = 0;
function nextProject(): string { return `${P}${++testCounter}`; }

/** A production-minted §8.2 token (the sole ActorCapability source, capabilities.ts). The P5 port
 *  performs no authorization — §8.3's broker matrix does — so the token is passed as the actor
 *  binding the coordinator would resolve (G5-W4.3). */
const CAP = mintActorCapability({
  trial_id: 'trial-ports',
  task_id: 'ab12',
  dispatch_generation: 'gen-1',
  attempt_id: 'attempt-1',
  role: 'coder',
  ancestry: ['root'],
  capability_whitelist: ['artifact.write', 'task.read'],
  issued_at_epoch_ms: 0,
});

function makeFixtureRepo(): {
  cleanup: () => void;
  tasksPathFor: (project: string) => string;
  project: string;
  seedTaskId: string;
} {
  const project = nextProject();
  const seedTaskId = `ab${String(testCounter).padStart(2, '0')}cd`;
  const dir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  const tasksPath = path.join(dir, 'TASKS.yaml');
  fs.writeFileSync(tasksPath, SEED_TASKS_YAML(seedTaskId));
  return {
    project,
    seedTaskId,
    cleanup: () => {
      try { fs.unlinkSync(tasksPath); } catch {}
      try { fs.rmdirSync(dir); } catch {}
    },
    tasksPathFor: () => tasksPath,
  };
}

function trialClock(remainingMs = 60_000): ReturnType<typeof createTrialClock> {
  return createTrialClock({ deadlineEpochMs: Date.now() + remainingMs });
}

function trialMutator(store: TaskRepo): TaskMutator {
  const repo = createTrialTaskRepository(store);
  return new TaskMutator(repo as unknown as TaskRepo);
}

// ── P2 — the git severance, proven by effect ─────────────────────

it('P2: a trial-scoped mutation creates no git subprocess, even through a git-armed delegate', async () => {
  const fx = makeFixtureRepo();
  try {
    // The delegate is deliberately NOT skipGit: the severance must be the port's, not the flag's.
    const store = new TaskRepo();
    const mutator = trialMutator(store);
    const table = createTrialTaskLockTable(trialClock());
    const owner = getOwnerIdentity();

    await withTrialTaskLockScope(table, async () => {
      const lock = table.acquire(fx.project, owner);
      assert.equal(lock.acquired, true, lock.message);
      try {
        const result = await mutator.add(
          fx.project, 'Trial task', 'why-trial', 'done-trial', 'medium', 'coder-review',
        );
        assert.equal(result.success, true, result.message);
      } finally {
        table.release(fx.project, owner);
      }
    });

    // The mutation itself persisted — only the git side is severed.
    const disk = fs.readFileSync(fx.tasksPathFor(fx.project), 'utf8');
    assert.match(disk, /Trial task/);

    // No git subprocess was created by the trial-scoped mutation.
    expect(gitProcess.execSync).not.toHaveBeenCalled();
    expect(gitProcess.execFileSync).not.toHaveBeenCalled();
    expect(gitProcess.spawn).not.toHaveBeenCalled();
  } finally {
    fx.cleanup();
  }
});

it('P2: the trial repository reads and lists through the delegate', async () => {
  const fx = makeFixtureRepo();
  try {
    const store = new TaskRepo({ skipGit: true });
    const repo = createTrialTaskRepository(store);
    store.load();
    assert.equal(repo.getById(fx.seedTaskId)?.id, fx.seedTaskId);
    assert.equal(repo.getById('missing'), null);
    assert.equal(repo.list({ project: fx.project }).length, 1);
    assert.equal(repo.list({ project: fx.project, status: 'done' }).length, 0);
    assert.ok(Array.isArray(repo.getActionable()));
    repo.refresh();
    await repo.runExclusive(() => undefined);
    await repo.flush();
  } finally {
    fx.cleanup();
  }
});

it('P2 (daemon pin): TaskRepo.commitAndPush still shells out git add/commit/push exactly as shipped', () => {
  // The daemon path is a frozen contract: a plain TaskRepo must still `git add` (execSync),
  // `git commit` (execFileSync) and detach `git push origin main` (spawn).
  gitProcess.execSync.mockImplementation((cmd: unknown) => (
    String(cmd).includes('status') ? ' M _test_proj/TASKS.yaml' : Buffer.from('')
  ));
  gitProcess.execFileSync.mockReturnValue(Buffer.from(''));
  gitProcess.spawn.mockReturnValue({
    stderr: { on: vi.fn() },
    on: vi.fn(),
    unref: vi.fn(),
  } as unknown as ReturnType<typeof import('node:child_process').spawn>);

  const repo = new TaskRepo();
  repo.commitAndPush('task-store: test message');

  expect(gitProcess.execSync).toHaveBeenCalledWith(
    expect.stringContaining('git add'), expect.objectContaining({ timeout: 10000 }),
  );
  expect(gitProcess.execSync).toHaveBeenCalledWith(
    expect.stringContaining('git status --porcelain'), expect.objectContaining({ timeout: 5000 }),
  );
  expect(gitProcess.execFileSync).toHaveBeenCalledWith(
    'git', [expect.stringContaining('commit'), '-m', 'task-store: test message'],
    expect.objectContaining({ timeout: 10000 }),
  );
  expect(gitProcess.spawn).toHaveBeenCalledWith(
    'git', ['push', 'origin', 'main'],
    expect.objectContaining({ detached: true }),
  );
});

// ── P4 — the trial owns its locks ────────────────────────────────

it('P4: in-trial locking is the trial\'s own — a host lock neither blocks nor is touched', async () => {
  const fx = makeFixtureRepo();
  try {
    // A real user's host lock lives in the project's TASKS.yaml lock metadata.
    const hostOwner = 'manual:realuser:4242';
    writeLock(fx.project, {
      owner: hostOwner,
      acquired_at: new Date().toISOString(),
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(isProjectLocked(fx.project).locked, true, 'host must see its own lock');

    const table = createTrialTaskLockTable(trialClock());
    await withTrialTaskLockScope(table, async () => {
      // The trial does not see the host lock, and acquires its own.
      assert.equal(isProjectLocked(fx.project).locked, false, 'trial must not block on a host lock');
      const r = acquireLock(fx.project, { owner: 'trial-actor' });
      assert.equal(r.acquired, true, r.message);
      assert.equal(assertLockHeld(fx.project, 'trial-actor'), null);
      assert.equal(isProjectLocked(fx.project).locked, true);
      assert.equal(isProjectLocked(fx.project).owner, 'trial-actor');
      assert.equal(releaseLock(fx.project, 'trial-actor').released, true);
      assert.equal(isProjectLocked(fx.project).locked, false);
    });

    // The trial's lock never leaked into the host file; the host lock is intact.
    const disk = fs.readFileSync(fx.tasksPathFor(fx.project), 'utf8');
    assert.match(disk, /owner:\s*manual:realuser:4242/);
  } finally {
    fx.cleanup();
  }
});

it('P4: a trial mutation proceeds while a real user holds the host lock', async () => {
  const fx = makeFixtureRepo();
  try {
    writeLock(fx.project, {
      owner: 'manual:realuser:4242',
      acquired_at: new Date().toISOString(),
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    const mutator = trialMutator(new TaskRepo({ skipGit: true }));
    const table = createTrialTaskLockTable(trialClock());
    const owner = getOwnerIdentity();

    await withTrialTaskLockScope(table, async () => {
      const lock = table.acquire(fx.project, owner);
      assert.equal(lock.acquired, true, lock.message);
      try {
        const result = await mutator.add(fx.project, 'Trial add', 'w', 'd', 'medium', 'coder-review');
        assert.equal(result.success, true, result.message);
      } finally {
        table.release(fx.project, owner);
      }
    });

    assert.match(fs.readFileSync(fx.tasksPathFor(fx.project), 'utf8'), /Trial add/);
  } finally {
    fx.cleanup();
  }
});

it('P4: the system-lock spin cannot hang a trial — a contended in-trial acquire raises', async () => {
  const fx = makeFixtureRepo();
  try {
    const mutator = trialMutator(new TaskRepo({ skipGit: true }));
    const table = createTrialTaskLockTable(trialClock());
    await withTrialTaskLockScope(table, async () => {
      assert.equal(table.acquire(fx.project, 'someone-else').acquired, true);
      const started = Date.now();
      await assert.rejects(
        mutator.add(fx.project, 'sys', 'w', 'd', 'medium', 'coder-review', undefined, { system: true }),
        TrialLockContendedError,
      );
      // The bound is zero retries: the raise exits mutator.ts:84-90's `while (!acquireLock(...))`
      // on its first evaluation instead of feeding an unbounded spin.
      assert.ok(Date.now() - started < 5_000, 'a contended in-trial system add must fail fast');
    });
  } finally {
    fx.cleanup();
  }
});

it('P4: the trial lock TTL is derived from the trial deadline, not the fixed 20 minutes', () => {
  const remaining = 5 * 60_000;
  const table = createTrialTaskLockTable(trialClock(remaining));
  const r = table.acquire('p', 'a');
  assert.equal(r.acquired, true, r.message);
  const ttlMs = Date.parse(r.lock!.expires_at) - Date.parse(r.lock!.acquired_at);
  assert.ok(Math.abs(ttlMs - remaining) < 2_000, `TTL ${ttlMs}ms must follow the trial deadline (${remaining}ms)`);
});

it('P4: an expired trial lock reads as free', () => {
  const expired = createTrialTaskLockTable(createTrialClock({ deadlineEpochMs: Date.now() - 1_000 }));
  assert.equal(expired.acquire('p', 'dead').acquired, true);
  assert.equal(expired.isProjectLocked('p').locked, false);
  assert.equal(expired.acquire('p', 'alive').acquired, true);
});

it('P4: the trial table shape satisfies the lock scope\'s table contract (compile-time pin)', () => {
  // The benchmark port keeps the host lock implementation out of its construction surface, so
  // the table contract is structural; this assignment compiles only while the shapes
  // match, and the runtime calls below pin the behaviour.
  const table: import('../../../src/domain/tasks/system/task-lock.js').TrialTaskLockTable =
    createTrialTaskLockTable(trialClock());
  assert.equal(typeof table.acquire, 'function');
  assert.equal(typeof table.release, 'function');
  assert.equal(typeof table.assertHeld, 'function');
  assert.equal(typeof table.isProjectLocked, 'function');
});

it('P4: the TrialTaskLocks port exposes acquire/release/assertHeld/isLocked', () => {
  const locks = createTrialTaskLocks(createTrialTaskLockTable(trialClock()));
  const r = locks.acquire('p', 'actor-1');
  assert.equal(r.acquired, true);
  assert.equal(r.lock!.owner, 'actor-1');
  assert.ok(r.lock!.acquiredAt);
  assert.ok(r.lock!.expiresAt);
  assert.equal(locks.assertHeld('p', 'actor-1'), null);
  assert.equal(locks.assertHeld('p', 'other'), 'Lock held by different owner: actor-1');
  assert.deepEqual(locks.isLocked('p'), { locked: true, owner: 'actor-1' });
  assert.equal(locks.release('p', 'actor-1').released, true);
  assert.deepEqual(locks.isLocked('p'), { locked: false });
});

it('P4 (daemon pin): the unscoped lock keeps the fixed 20-minute TTL', () => {
  const project = nextProject();
  const dir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  const tasksPath = path.join(dir, 'TASKS.yaml');
  fs.writeFileSync(tasksPath, SEED_TASKS_YAML('daemonseed'));
  try {
    const r = acquireLock(project, { owner: 'owner-A' });
    assert.equal(r.acquired, true, r.message);
    assert.equal(r.lock!.owner, 'owner-A');
    const ttlMs = Date.parse(r.lock!.expires_at) - Date.parse(r.lock!.acquired_at);
    assert.ok(
      Math.abs(ttlMs - 1_200_000) < 2_000,
      `daemon TTL must stay 20 minutes (was ${ttlMs}ms)`,
    );
    const stored = readLock(project);
    assert.equal(stored!.owner, 'owner-A');
  } finally {
    try { fs.unlinkSync(tasksPath); } catch {}
    try { fs.rmdirSync(dir); } catch {}
  }
});

// ── P5 — the artifact root repointed at the trial root ───────────

function trialRoot(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-root-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

it('P5: artifact paths and writes resolve under the trial root, never the host PROJECTS_DIR', () => {
  const { root, cleanup } = trialRoot();
  try {
    const project = 'bench-proj';
    const taskId = 'ab12';
    const artifacts = createTaskArtifactProjection({
      root, project, resolveTaskId: () => taskId,
    });

    assert.equal(artifacts.nodeDir(project, taskId), path.join(root, project, 'manager', taskId));
    assert.equal(
      artifacts.artifactPath(project, taskId),
      path.join(root, project, 'manager', taskId, 'artifact.md'),
    );

    artifacts.write(CAP, '# checkpoint');
    const p = artifacts.artifactPath(project, taskId);
    assert.equal(fs.readFileSync(p, 'utf8'), '# checkpoint');
    assert.equal(artifacts.read(CAP), '# checkpoint');

    // The write cannot land under the host PROJECTS_DIR.
    const hostRoot = path.resolve(PROJECTS_DIR);
    const resolved = path.resolve(p);
    assert.ok(
      resolved !== hostRoot && !resolved.startsWith(hostRoot + path.sep),
      `trial artifact ${resolved} must not resolve under host PROJECTS_DIR ${hostRoot}`,
    );

    // ensure() must never truncate an existing artifact (rotation/rehydration depend on it).
    artifacts.ensure(project, taskId);
    assert.equal(fs.readFileSync(p, 'utf8'), '# checkpoint');
  } finally {
    cleanup();
  }
});

it('P5: the shipped proposal-seal helper resolves under the trial root, never host PROJECTS_DIR', () => {
  const { root, cleanup } = trialRoot();
  const project = 'bench-proposal-scope';
  const taskId = 'ab12';
  const hostPath = path.join(PROJECTS_DIR, project, 'manager', taskId, 'proposals.json');
  try {
    withTrialTaskArtifactScope(root, () => recordProposal(project, {
      key: { task_id: taskId, dispatch_generation: 'generation', attempt_id: 'attempt' },
      intent: 'complete',
      note: null,
    }));

    assert.ok(fs.existsSync(path.join(root, project, 'manager', taskId, 'proposals.json')));
    assert.ok(!fs.existsSync(hostPath));
  } finally {
    cleanup();
  }
});

it('P5: a write escaping the trial root is out_of_trial_path (code 36), never a write', () => {
  const { root, cleanup } = trialRoot();
  try {
    const artifacts = createTaskArtifactProjection({
      root, project: 'p', resolveTaskId: () => '../../../escape',
    });
    const isCode36 = (e: unknown): boolean =>
      e instanceof PolicyCompilationError && e.code === 36;
    // Direct taskId escape (ensure's own argument) and resolver-mediated escape (read/write).
    assert.throws(() => artifacts.ensure('p', '../../../escape'), isCode36);
    assert.throws(() => artifacts.write(CAP, 'x'), isCode36);
    assert.throws(() => artifacts.read(CAP), isCode36);
    // Nothing was created outside the trial root.
    assert.ok(!fs.existsSync(path.join(path.dirname(root), 'escape')));
  } finally {
    cleanup();
  }
});

it('P5: realpath containment rejects an in-root symlink before writing outside the trial root', () => {
  const { root, cleanup } = trialRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'host-root-sim-'));
  try {
    const managerDir = path.join(root, 'p', 'manager');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.symlinkSync(outside, path.join(managerDir, 'task'));
    const artifacts = createTaskArtifactProjection({
      root, project: 'p', resolveTaskId: () => 'task',
    });
    const isCode36 = (e: unknown): boolean =>
      e instanceof PolicyCompilationError && e.code === 36;

    assert.throws(() => artifacts.write(CAP, 'escaped'), isCode36);
    assert.ok(!fs.existsSync(path.join(outside, 'artifact.md')));
  } finally {
    cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it('P5: write resolves the broker actor binding exactly once before containment', () => {
  const { root, cleanup } = trialRoot();
  try {
    let resolutions = 0;
    const artifacts = createTaskArtifactProjection({
      root,
      project: 'p',
      resolveTaskId: () => (++resolutions === 1 ? 'task' : 'different-task'),
    });

    artifacts.write(CAP, 'one binding');
    assert.equal(resolutions, 1);
    assert.equal(
      fs.readFileSync(path.join(root, 'p', 'manager', 'task', 'artifact.md'), 'utf8'),
      'one binding',
    );
    assert.ok(!fs.existsSync(path.join(root, 'p', 'manager', 'different-task')));
  } finally {
    cleanup();
  }
});

it('P5: read/write without the broker actor binding fail closed (runtime_port_unbound)', () => {
  const { root, cleanup } = trialRoot();
  try {
    const artifacts = createTaskArtifactProjection({ root, project: 'p' });
    assert.throws(
      () => artifacts.write(CAP, 'x'),
      (e: unknown) => e instanceof PolicyCompilationError && e.reason === 'runtime_port_unbound',
    );
  } finally {
    cleanup();
  }
});

it('P5 (daemon pin): the task-node functions keep the host PROJECTS_DIR root by default', () => {
  assert.equal(managerNodeDir('p', 't'), path.join(PROJECTS_DIR, 'p', 'manager', 't'));
  assert.equal(taskArtifactPath('p', 't'), path.join(PROJECTS_DIR, 'p', 'manager', 't', 'artifact.md'));
  const dir = path.join(PROJECTS_DIR, '_tn_daemon_pin');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const p = ensureTaskArtifact('_tn_daemon_pin', 'wxyz');
    assert.equal(p, path.join(PROJECTS_DIR, '_tn_daemon_pin', 'manager', 'wxyz', 'artifact.md'));
    assert.ok(fs.existsSync(p));
  } finally {
    try { fs.rmSync(path.join(PROJECTS_DIR, '_tn_daemon_pin', 'manager'), { recursive: true }); } catch {}
    try { fs.rmdirSync(dir); } catch {}
  }
});

// ── Wiring — the ports are reachable through the frozen interface module ──

it('P2/P4/P5: the structural port shapes satisfy the frozen §7.2 declarations (compile-time pins)', () => {
  // trial-task-ports.ts keeps its factory surface independent of the broad composite bundle, so
  // the port shapes are structural. Each assignment below compiles only while the shapes match.
  const repo: import('../../../src/domain/benchmark/composite-runtime-ports.js').TrialTaskRepository =
    createTrialTaskRepository({ getById: () => null, getAll: () => [], getActionable: () => [], refresh: () => {}, runExclusive: async (fn) => fn(), flush: async () => {} });
  assert.equal(typeof repo.list, 'function');
  const locks: import('../../../src/domain/benchmark/composite-runtime-ports.js').TrialTaskLocks =
    createTrialTaskLocks(createTrialTaskLockTable(trialClock()));
  assert.equal(typeof locks.isLocked, 'function');
  const artifacts: import('../../../src/domain/benchmark/composite-runtime-ports.js').TaskArtifactProjection =
    createTaskArtifactProjection({ root: '/tmp', project: 'p', resolveTaskId: () => 't' });
  assert.equal(typeof artifacts.write, 'function');
  assert.equal(typeof artifacts.ensure, 'function');
});

it('wiring: the P2/P4/P5 factories are exported by composite-runtime-ports.ts', () => {
  assert.equal(typeof wiredRepository, 'function');
  assert.equal(typeof wiredLocks, 'function');
  assert.equal(typeof wiredArtifacts, 'function');
  const { root, cleanup } = trialRoot();
  try {
    const repo = wiredRepository({ getById: () => null, getAll: () => [], getActionable: () => [], refresh: () => {}, runExclusive: async (fn) => fn(), flush: async () => {} });
    assert.equal(repo.getById('x'), null);
    assert.equal(typeof repo.commitAndPush, 'function');
    const locks = wiredLocks(createTrialTaskLockTable(trialClock()));
    assert.deepEqual(locks.isLocked('p'), { locked: false });
    const artifacts = wiredArtifacts({ root, project: 'p', resolveTaskId: () => 't' });
    artifacts.ensure('p', 't');
    assert.ok(fs.existsSync(artifacts.artifactPath('p', 't')));
  } finally {
    cleanup();
  }
});
