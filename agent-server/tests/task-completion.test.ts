// input:  Node test runner + task-system/task-completion API
// output: complete/uncomplete unit tests (TASKS.yaml format)
// pos:    Verify complete/uncomplete API
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { PROJECTS_DIR } from '../src/core/paths.js';
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
