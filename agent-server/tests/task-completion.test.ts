// input:  Node test runner + task-system/task-completion API
// output: completion lifecycle and evidence regression tests
// pos:    verifies complete/uncomplete and completion evidence
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as yamlParse } from 'yaml';
import { DATA_DIR, PROJECTS_DIR } from '../src/core/paths.js';
import { completeTask, uncompleteTask } from '../src/domain/tasks/system/task-completion.js';

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

function makeImplementationRepo(): { dir: string; sha: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'tmp', 'completion-evidence-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'implementation.txt'), 'verified implementation\n');
  execFileSync('git', ['add', 'implementation.txt'], { cwd: dir });
  execFileSync('git', [
    '-c', 'user.name=Cortex Test',
    '-c', 'user.email=cortex-test@example.com',
    'commit', '--quiet', '-m', 'Implement completion evidence',
  ], { cwd: dir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, sha, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function setCurrentThreadId(threadId: string): () => void {
  const previous = process.env.CORTEX_THREAD_ID;
  process.env.CORTEX_THREAD_ID = threadId;
  return () => {
    if (previous === undefined) delete process.env.CORTEX_THREAD_ID;
    else process.env.CORTEX_THREAD_ID = previous;
  };
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
    assert.ok(task['completed-at']);
    assert.equal(task['claimed-by'] || null, null);
    assert.equal(task['approval-needed'] || false, false);
    assert.equal(task.paused || false, false);
    assert.equal(task['blocked-by'] || null, null);
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

test('uncompleteTask flips status back to open and clears completed_at/completed_note', () => {
  const proj = np();
  const { tasksPath, cleanup } = makeRepo(proj, 'tasks:\n  - id: a111\n    text: Task\n    why: ""\n    done-when: ""\n    priority: high\n    status: done\n    template: coder-review\n    plan: ""\n    completed-at: "2026-01-01"\n    completed-note: done\n');
  try {
    const result = uncompleteTask(null, proj, 'a111');
    assert.equal(result.success, true);

    const parsed = readYaml(tasksPath);
    const task = findTask(parsed.tasks, 'a111');
    assert.equal(task.status, 'open');
    assert.equal(task['completed-at'] || null, null);
    assert.equal(task['completed-note'] || null, null);
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
