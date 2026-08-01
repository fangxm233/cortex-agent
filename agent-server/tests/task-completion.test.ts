// input:  Vitest, completion and state lifecycle APIs
// output: generation fencing, timestamps, and evidence regressions
// pos:    Verifies completion ownership and persisted evidence
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { parse as yamlParse } from 'yaml';
import { DATA_DIR, PROJECTS_DIR, STORE_DIR } from '../src/core/paths.js';
import { completeTask, uncompleteTask } from '../src/domain/tasks/system/task-completion.js';
import { claimTask, unclaimTask } from '../src/domain/tasks/system/task-state.js';

function readYaml(filePath: string): any {
  return yamlParse(fs.readFileSync(filePath, 'utf8'));
}

function findTask(tasks: any[], id: string): any {
  return tasks.find((t: any) => t.id === id);
}

function makeRepo(project: string, content: string): { tasksPath: string; cleanup: () => void } {
  const projectDir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(projectDir, { recursive: true });
  const tasksPath = path.join(projectDir, 'TASKS.yaml');
  const backup = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : null;
  fs.writeFileSync(tasksPath, content);
  return {
    tasksPath,
    cleanup: () => {
      if (backup !== null) fs.writeFileSync(tasksPath, backup);
      else { try { fs.unlinkSync(tasksPath); } catch {} }
      try { fs.rmdirSync(projectDir); } catch {}
    },
  };
}

const P = '_test_comp_';
let n = 0;
function np(): string { return `${P}${++n}`; }

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function initializeImplementationRepo(dir: string): { sha: string; nonCommitShas: string[] } {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'implementation.txt'), 'verified implementation\n');
  execFileSync('git', ['add', 'implementation.txt'], { cwd: dir });
  execFileSync('git', [
    '-c', 'user.name=Cortex Test',
    '-c', 'user.email=cortex-test@example.com',
    'commit', '--quiet', '-m', 'Implement completion evidence',
  ], { cwd: dir });
  const revParse = (ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf8' }).trim();
  return { sha: revParse('HEAD'), nonCommitShas: [revParse('HEAD:implementation.txt'), revParse('HEAD^{tree}')] };
}

function makeImplementationRepo(): { dir: string; sha: string; nonCommitShas: string[]; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'tmp', 'completion-evidence-'));
  const evidence = initializeImplementationRepo(dir);
  return { dir, ...evidence, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function setCurrentThreadId(threadId: string): () => void {
  const previous = process.env.CORTEX_THREAD_ID;
  process.env.CORTEX_THREAD_ID = threadId;
  return () => {
    if (previous === undefined) delete process.env.CORTEX_THREAD_ID;
    else process.env.CORTEX_THREAD_ID = previous;
  };
}

function setPersistedArtifact(threadId: string, artifactPath: string): () => void {
  const threadsPath = path.join(DATA_DIR, 'data', 'threads.json');
  const backup = fs.existsSync(threadsPath) ? fs.readFileSync(threadsPath, 'utf8') : null;
  fs.mkdirSync(path.dirname(threadsPath), { recursive: true });
  fs.writeFileSync(threadsPath, JSON.stringify({ [threadId]: { artifactPath } }));
  return () => {
    if (backup === null) fs.rmSync(threadsPath, { force: true });
    else fs.writeFileSync(threadsPath, backup);
  };
}

function assertPersistedArtifactRejected(label: string, artifactPath: string): void {
  const proj = np();
  const threadId = `thr_${label}_escape`;
  const restoreThreadId = setCurrentThreadId(threadId);
  const restoreThreads = setPersistedArtifact(threadId, artifactPath);
  const taskRepo = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  try {
    const result = completeTask(null, proj, 'Implementation completed', 'a111');
    assert.match(result.verify_warning as string, /no evidence/, label);
  } finally {
    taskRepo.cleanup();
    restoreThreads();
    restoreThreadId();
  }
}

function probeExternalProjectArtifact(): any {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-external-projects-'));
  const home = path.join(root, 'home');
  const projects = path.join(root, 'external-projects');
  const projectDir = path.join(projects, 'atlas');
  const artifactPath = path.join(projectDir, 'manager', 'a111', 'artifact.md');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'TASKS.yaml'), 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  fs.writeFileSync(artifactPath, '## Implementation Summary\n\nVerified work.\n');
  fs.writeFileSync(path.join(home, 'data', 'threads.json'), JSON.stringify({ thr_external: { artifactPath } }));
  const script = "import { completeTask } from './src/domain/tasks/system/task-completion.ts'; console.log(JSON.stringify(completeTask(null, 'atlas', 'done', 'a111')));";
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, CORTEX_HOME: home, CORTEX_PROJECTS_DIR: projects, CORTEX_THREAD_ID: 'thr_external' },
    });
    return JSON.parse(output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

type ProbeArtifactState = 'non-empty' | 'empty' | 'missing';
type ProbeShaState = 'valid' | 'invalid' | 'missing';
interface CompletionProbeOverrides {
  repositoryProject?: string;
  artifactTaskId?: string;
  artifactProject?: string;
}

function writeProbeStores(
  home: string, codeDir: string, artifactPath: string, overrides: CompletionProbeOverrides,
): void {
  const repositoryProject = overrides.repositoryProject ?? 'atlas';
  fs.writeFileSync(path.join(home, 'data', 'project-dirs.json'), JSON.stringify({
    [repositoryProject]: { local: codeDir },
  }));
  fs.writeFileSync(path.join(home, 'data', 'threads.json'), JSON.stringify({
    thr_persisted: { artifactPath, metadata: {
      taskId: overrides.artifactTaskId ?? 'a111',
      taskProject: overrides.artifactProject ?? 'atlas',
    } },
  }));
}

function writeCompletionProbe(
  root: string, artifactState: ProbeArtifactState, overrides: CompletionProbeOverrides,
) {
  const home = path.join(root, 'home');
  const projects = path.join(root, 'projects');
  const projectDir = path.join(projects, 'atlas');
  const codeDir = path.join(root, 'code');
  const artifactPath = path.join(home, 'tmp', 'threads', 'thr_persisted', 'artifact.md');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(codeDir, { recursive: true });
  const { sha } = initializeImplementationRepo(codeDir);
  fs.writeFileSync(path.join(projectDir, 'TASKS.yaml'), 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  writeProbeStores(home, codeDir, artifactPath, overrides);
  if (artifactState !== 'missing') {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, artifactState === 'empty' ? '  \n' : 'Verified persisted work.\n');
  }
  return { home, projects, sha };
}

function probeCompletionEvidence(
  shaState: ProbeShaState, artifactState: ProbeArtifactState,
  overrides: CompletionProbeOverrides = {},
): any {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-project-evidence-'));
  const { home, projects, sha } = writeCompletionProbe(root, artifactState, overrides);
  const noteSha = shaState === 'valid' ? sha : 'f'.repeat(40);
  const note = shaState === 'missing' ? 'Implementation completed' : `Implementation SHA: ${noteSha}`;
  const script = `import { completeTask } from './src/domain/tasks/system/task-completion.ts'; console.log(JSON.stringify(completeTask(null, 'atlas', ${JSON.stringify(note)}, 'a111')));`;
  const env: NodeJS.ProcessEnv = { ...process.env, CORTEX_HOME: home, CORTEX_PROJECTS_DIR: projects };
  delete env.CORTEX_THREAD_ID;
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), encoding: 'utf8', env,
    });
    return JSON.parse(output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('completeTask marks status done, sets completed_at, clears in-progress state, returns task_id', () => {
  const proj = np();
  const { tasksPath, cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n    claimed-by: agent\n    claimed-at: "2026-01-01"\n    approval-needed: true\n');
  try {
    const result = completeTask(null, proj, 'note ok', 'a111');
    assert.equal(result.success, true);
    assert.equal(result.task_id, 'a111');

    const parsed = readYaml(tasksPath);
    const task = findTask(parsed.tasks, 'a111');
    assert.equal(task.status, 'done');
    assert.equal(task['completed-note'], 'note ok');
    assert.match(task['completed-at'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(task['claimed-by'] || null, null);
    assert.equal(task['approval-needed'] || false, false);
    assert.equal(task.paused || false, false);
    assert.equal(task['blocked-by'] || null, null);
  } finally { cleanup(); }
});

test('ownerless mutation locks are reclaimed after the crash grace period', () => {
  const proj = np();
  const { tasksPath, cleanup } = makeRepo(proj, 'tasks:\n  - id: a115\n    text: Crash recovery\n    why: test\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n');
  const lockPath = path.join(STORE_DIR, 'task-mutation-locks', encodeURIComponent(proj));
  let tombstone = '';
  try {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, '.reclaimed'), '');
    const old = new Date(Date.now() - 2_000);
    fs.utimesSync(lockPath, old, old);
    const stat = fs.statSync(lockPath);
    const ctime = String(stat.ctimeMs).replace('.', '-');
    tombstone = `${lockPath}.reclaimed.${stat.dev}.${stat.ino}.${ctime}`;
    const result = claimTask(null, proj, 'task-dispatcher', 'a115');
    assert.equal(result.success, true);
    assert.equal(findTask(readYaml(tasksPath).tasks, 'a115')['claimed-by'], 'task-dispatcher');
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
    if (tombstone) fs.rmSync(tombstone, { recursive: true, force: true });
    cleanup();
  }
});

test('task generation transitions wait for the cross-process mutation lock', async () => {
  const proj = np();
  const marker = path.join(os.tmpdir(), `task-mutation-lock-${process.pid}-${n}`);
  const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a114\n    text: Locked task\n    why: test\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n');
  const script = `import fs from 'node:fs'; import { withTaskFileMutationLock } from './src/domain/tasks/system/task-lifecycle-edit.ts'; withTaskFileMutationLock(${JSON.stringify(proj)}, () => { fs.writeFileSync(${JSON.stringify(marker)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); });`;
  const holder = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(), env: process.env, stdio: 'ignore',
  });
  try {
    await waitForFile(marker);
    const started = Date.now();
    const result = claimTask(null, proj, 'task-dispatcher', 'a114', 'generation-a');
    assert.equal(result.success, true);
    assert.ok(Date.now() - started >= 150, 'claim must wait for the other process to release the task lock');
  } finally {
    holder.kill();
    fs.rmSync(marker, { force: true });
    cleanup();
  }
});

test('cross-process lock contention retries publication races instead of throwing', async () => {
  const proj = np();
  const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a117\n    text: Contended lock\n    why: test\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n');
  const script = [
    `import { withTaskFileMutationLock } from './src/domain/tasks/system/task-lifecycle-edit.ts';`,
    `for (let i = 0; i < 100; i++) withTaskFileMutationLock(${JSON.stringify(proj)}, () => {});`,
  ].join(' ');
  try {
    const runs = Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        cwd: process.cwd(), env: process.env, stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`lock contender exited ${code}`));
      });
    }));
    await Promise.all(runs);
  } finally {
    cleanup();
  }
});

test('a late stale reclaimer cannot rename a newly acquired lock over the inode tombstone', () => {
  const proj = np();
  const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a116\n    text: Reclaim ABA\n    why: test\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n');
  const lockPath = path.join(STORE_DIR, 'task-mutation-locks', encodeURIComponent(proj));
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, '.reclaimed'), '');
  const old = new Date(Date.now() - 2_000);
  fs.utimesSync(lockPath, old, old);
  const stat = fs.statSync(lockPath);
  const ctime = String(stat.ctimeMs).replace('.', '-');
  const tombstone = `${lockPath}.reclaimed.${stat.dev}.${stat.ino}.${ctime}`;
  try {
    assert.equal(claimTask(null, proj, 'task-dispatcher', 'a116').success, true);
    assert.equal(fs.existsSync(tombstone), true);
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid, token: 'new-owner', processStart: null,
    }));
    assert.throws(() => fs.renameSync(lockPath, tombstone));
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.rmSync(tombstone, { recursive: true, force: true });
    cleanup();
  }
});

test('completeTask rejects a stale dispatch generation and accepts the current owner', () => {
  const proj = np();
  const { tasksPath, cleanup } = makeRepo(proj, 'tasks:\n  - id: a112\n    text: Reworked task\n    why: test\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n');
  try {
    assert.equal(claimTask(null, proj, 'task-dispatcher', 'a112', 'generation-a').success, true);
    assert.equal(completeTask(
      null, proj, 'Implementation SHA: aaaaaaa', 'a112', false, null,
      { generation: 'generation-a' },
    ).success, true);
    assert.equal(uncompleteTask(null, proj, 'a112').success, true);
    assert.equal(claimTask(null, proj, 'task-dispatcher', 'a112', 'rework-claim').success, true);
    assert.equal(unclaimTask(null, proj, 'a112').success, true);
    assert.equal(claimTask(null, proj, 'task-dispatcher', 'a112', 'generation-b').success, true);

    const stale = completeTask(
      null, proj, 'Implementation SHA: aaaaaaa', 'a112', false, null,
      { generation: 'generation-a' },
    );
    assert.equal(stale.success, false);
    assert.match(stale.message, /stale|generation/i);

    let task = findTask(readYaml(tasksPath).tasks, 'a112');
    assert.equal(task.status, 'open');
    assert.equal(task['claimed-by'], 'task-dispatcher');
    assert.equal(task['dispatch-generation'], 'generation-b');
    assert.equal(task['completed-note'] ?? null, null);

    const current = completeTask(
      null, proj, 'Implementation SHA: bbbbbbb', 'a112', false, null,
      { generation: 'generation-b' },
    );
    assert.equal(current.success, true);
    task = findTask(readYaml(tasksPath).tasks, 'a112');
    assert.equal(task.status, 'done');
    assert.equal(task['dispatch-generation'], 'generation-b');
    assert.equal(task['completed-note'], 'Implementation SHA: bbbbbbb');
  } finally { cleanup(); }
});

test('manual complete remains an explicit override and clears dispatch ownership', () => {
  const proj = np();
  const { tasksPath, cleanup } = makeRepo(proj, 'tasks:\n  - id: a113\n    text: Manual override\n    why: test\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n    claimed-by: task-dispatcher\n    claimed-at: "2026-01-02"\n    dispatch-generation: generation-b\n');
  try {
    const result = completeTask(null, proj, 'manual result', 'a113');
    assert.equal(result.success, true);
    const task = findTask(readYaml(tasksPath).tasks, 'a113');
    assert.equal(task.status, 'done');
    assert.equal(task['completed-note'], 'manual result');
    assert.equal(task['dispatch-generation'] ?? null, null);
  } finally { cleanup(); }
});

test('completeTask refuses already-completed, paused, or blocked tasks', () => {
  const p1 = np();
  const r1 = makeRepo(p1, 'tasks:\n  - id: a111\n    text: Task\n    why: ""\n    done-when: ""\n    priority: medium\n    status: done\n    template: coder-review\n    plan: ""\n');
  try {
    assert.equal(completeTask(null, p1, '', 'a111').success, false);
  } finally { r1.cleanup(); }

  const p2 = np();
  const r2 = makeRepo(p2, 'tasks:\n  - id: a111\n    text: Task\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n    paused: true\n');
  try {
    const pausedRes = completeTask(null, p2, '', 'a111');
    assert.equal(pausedRes.success, false);
    assert.match(pausedRes.message, /paused/);
  } finally { r2.cleanup(); }

  const p3 = np();
  const r3 = makeRepo(p3, 'tasks:\n  - id: a111\n    text: Task\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n    blocked-by: dep\n');
  try {
    const blockedRes = completeTask(null, p3, '', 'a111');
    assert.equal(blockedRes.success, false);
    assert.match(blockedRes.message, /blocked/);
  } finally { r3.cleanup(); }
});

test('completeTask clears depends-on dependencies across projects and reports unblocked list', () => {
  const pA = np();
  const pB = np();
  const pC = np();
  const rA = makeRepo(pA, 'tasks:\n  - id: a111\n    text: "Finish me"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  const rB = makeRepo(pB, 'tasks:\n  - id: b222\n    text: "Waits on alpha"\n    why: wait\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n    depends-on: [a111]\n');
  const rC = makeRepo(pC, 'tasks:\n  - id: c333\n    text: "Also waits"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n    depends-on: [a111]\n');
  try {
    const result = completeTask(null, pA, '', 'a111');
    assert.equal(result.success, true);
    assert.equal(result.unblocked.length, 2);
    const unblockedIds = result.unblocked.map((u: any) => u.taskId).sort();
    assert.deepEqual(unblockedIds, ['b222', 'c333']);

    const betaParsed = readYaml(rB.tasksPath);
    const betaTask = findTask(betaParsed.tasks, 'b222');
    assert.deepEqual(betaTask['depends-on'] || [], []);

    const gammaParsed = readYaml(rC.tasksPath);
    const gammaTask = findTask(gammaParsed.tasks, 'c333');
    assert.deepEqual(gammaTask['depends-on'] || [], []);
  } finally { rA.cleanup(); rB.cleanup(); rC.cleanup(); }
});

test('completeTask returns project-missing error when TASKS.yaml absent', () => {
  const result = completeTask(null, '_test_comp_ghost', '', 'a111');
  assert.equal(result.success, false);
  assert.match(result.message, /TASKS\.yaml not found/);
});

test('uncompleteTask flips status back to open and clears completion provenance', () => {
  const proj = np();
  const { tasksPath, cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: ""\n    done-when: ""\n    priority: high\n    status: done\n    template: coder-review\n    plan: ""\n    completed-at: "2026-01-01"\n    completed-note: done\n    dispatch-generation: generation-a\n');
  try {
    const result = uncompleteTask(null, proj, 'a111');
    assert.equal(result.success, true);

    const parsed = readYaml(tasksPath);
    const task = findTask(parsed.tasks, 'a111');
    assert.equal(task.status, 'open');
    assert.equal(task['completed-at'] || null, null);
    assert.equal(task['completed-note'] || null, null);
    assert.equal(task['dispatch-generation'] || null, null);
    assert.equal(task.priority, 'high');
  } finally { cleanup(); }
});

test('uncompleteTask refuses when task is not completed', () => {
  const proj = np();
  const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  try {
    const result = uncompleteTask(null, proj, 'a111');
    assert.equal(result.success, false);
    assert.match(result.message, /not completed/);
  } finally { cleanup(); }
});

// --- verify-completion tests ---

test('completeTask emits verify_warning when no git commit or done_when artifact found', () => {
  const proj = np();
  const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  try {
    const result = completeTask(null, proj, 'note', 'a111');
    assert.equal(result.success, true);
    assert.ok(result.verify_warning, 'expected a verify_warning');
    assert.match(result.verify_warning as string, /no evidence/);
  } finally { cleanup(); }
});

test('completeTask with skipVerify=true does not emit evidence warning, logs skip reason', () => {
  const proj = np();
  const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  try {
    const result = completeTask(null, proj, 'note', 'a111', true, 'manual inspection');
    assert.equal(result.success, true);
    assert.match(result.verify_warning as string, /verify skipped/);
    assert.match(result.verify_warning as string, /manual inspection/);
  } finally { cleanup(); }
});

test('completeTask sets verify_warning to null when done_when artifact exists in repo', () => {
  const proj = np();
  // done_when must reference a file path that actually exists on disk
  const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: "' + `context/projects/${proj}/TASKS.yaml exists` + '"\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  try {
    const result = completeTask(null, proj, 'note', 'a111');
    assert.equal(result.success, true);
    assert.equal(result.verify_warning, null);
  } finally { cleanup(); }
});

test('completeTask accepts an explicit implementation SHA without a task ID in commit text', () => {
  const proj = np();
  const taskRepo = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  const implementationRepo = makeImplementationRepo();
  const previousCwd = process.cwd();
  try {
    process.chdir(implementationRepo.dir);
    const result = completeTask(null, proj, `Implementation SHA: ${implementationRepo.sha}`, 'a111');
    assert.equal(result.success, true);
    assert.equal(result.verify_warning, null);
    const message = execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' });
    assert.doesNotMatch(message, /a111/);
  } finally {
    process.chdir(previousCwd);
    implementationRepo.cleanup();
    taskRepo.cleanup();
  }
});

test('completeTask rejects an explicit SHA that does not resolve to a commit', () => {
  const proj = np();
  const taskRepo = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  const implementationRepo = makeImplementationRepo();
  const previousCwd = process.cwd();
  try {
    process.chdir(implementationRepo.dir);
    const result = completeTask(null, proj, `Implementation SHA: ${'f'.repeat(40)}`, 'a111');
    assert.equal(result.success, true);
    assert.match(result.verify_warning as string, /no evidence/);
  } finally {
    process.chdir(previousCwd);
    implementationRepo.cleanup();
    taskRepo.cleanup();
  }
});

test('completeTask rejects existing blob and tree SHAs', () => {
  const implementationRepo = makeImplementationRepo();
  const previousCwd = process.cwd();
  try {
    process.chdir(implementationRepo.dir);
    for (const objectSha of implementationRepo.nonCommitShas) {
      const proj = np();
      const taskRepo = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
      try {
        const result = completeTask(null, proj, `Implementation SHA: ${objectSha}`, 'a111');
        assert.match(result.verify_warning as string, /no evidence/);
      } finally { taskRepo.cleanup(); }
    }
  } finally {
    process.chdir(previousCwd);
    implementationRepo.cleanup();
  }
});

test('completeTask accepts a non-empty current-thread artifact outside git', () => {
  const proj = np();
  const threadId = 'thr_completion_evidence';
  const restoreThreadId = setCurrentThreadId(threadId);
  const artifactDir = path.join(DATA_DIR, 'tmp', 'threads', threadId);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'artifact.md'), '## Implementation Summary\n\nVerified work.\n');
  const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
  try {
    const result = completeTask(null, proj, 'Implementation completed', 'a111');
    assert.equal(result.success, true);
    assert.equal(result.verify_warning, null);
  } finally {
    cleanup();
    restoreThreadId();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('completeTask rejects missing and empty current-thread artifacts', () => {
  for (const artifactState of ['missing', 'empty']) {
    const proj = np();
    const threadId = `thr_completion_${artifactState}`;
    const restoreThreadId = setCurrentThreadId(threadId);
    const artifactDir = path.join(DATA_DIR, 'tmp', 'threads', threadId);
    if (artifactState === 'empty') {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, 'artifact.md'), '   \n');
    }
    const { cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: test\n    done-when: done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n');
    try {
      const result = completeTask(null, proj, 'Implementation completed', 'a111');
      assert.equal(result.success, true);
      assert.match(result.verify_warning as string, /no evidence/, artifactState);
    } finally {
      cleanup();
      restoreThreadId();
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  }
});

test('completeTask accepts configured repository and matching persisted artifact evidence together', () => {
  const result = probeCompletionEvidence('valid', 'non-empty');
  assert.equal(result.success, true);
  assert.equal(result.verify_warning, null);
});

test('completeTask accepts a commit from the configured project repository without artifact evidence', () => {
  const result = probeCompletionEvidence('valid', 'missing');
  assert.equal(result.success, true);
  assert.equal(result.verify_warning, null);
});

test('completeTask accepts a persisted task artifact without current-thread environment', () => {
  const result = probeCompletionEvidence('missing', 'non-empty');
  assert.equal(result.success, true);
  assert.equal(result.verify_warning, null);
});

test('completeTask warns when configured commit and persisted artifact evidence are invalid or missing', () => {
  for (const artifactState of ['missing', 'empty'] as const) {
    const result = probeCompletionEvidence('invalid', artifactState);
    assert.match(result.verify_warning as string, /no evidence/, artifactState);
  }
});

test('completeTask ignores a valid commit configured only for another project', () => {
  const result = probeCompletionEvidence('valid', 'missing', { repositoryProject: 'orchard' });
  assert.match(result.verify_warning as string, /no evidence/);
});

test('completeTask rejects persisted artifacts matching only one task association field', () => {
  const mismatches: CompletionProbeOverrides[] = [
    { artifactProject: 'orchard' },
    { artifactTaskId: 'b222' },
  ];
  for (const mismatch of mismatches) {
    const result = probeCompletionEvidence('missing', 'non-empty', mismatch);
    assert.match(result.verify_warning as string, /no evidence/, JSON.stringify(mismatch));
  }
});

test('completeTask accepts a persisted artifact under an external configured project root', () => {
  const result = probeExternalProjectArtifact();
  assert.equal(result.success, true);
  assert.equal(result.verify_warning, null);
});

test('completeTask rejects persisted artifacts outside authorized roots and through symlink escape', () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-artifact-escape-'));
  const outsideArtifact = path.join(outsideDir, 'artifact.md');
  const symlinkDir = path.join(DATA_DIR, 'tmp', 'artifact-escape');
  const symlinkArtifact = path.join(symlinkDir, 'artifact.md');
  fs.writeFileSync(outsideArtifact, 'Verified work.\n');
  fs.mkdirSync(symlinkDir, { recursive: true });
  fs.symlinkSync(outsideArtifact, symlinkArtifact);
  try {
    assertPersistedArtifactRejected('outside', outsideArtifact);
    assertPersistedArtifactRejected('symlink', symlinkArtifact);
  } finally {
    fs.rmSync(symlinkDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
