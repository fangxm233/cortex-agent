// input:  Node test runner + task-parser parent field + decompose keep-parent + lint + split outcome
// output: Task.parent round-trip / decomposeTask keepParent / lint parent rules / processSplitOutcome tests
// pos:    Verify task-tree infrastructure (DR-0014 Phase 5)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { rawToTask, taskToYamlObj, parseTasksFile, serializeTasksFile } from '../src/core/task-parser.js';
import { decomposeTask } from '../src/domain/tasks/system/task-mutations.js';
import { lintTasks } from '../src/domain/tasks/lint.js';
import { processSplitOutcome } from '../src/domain/tasks/dispatch-utils.js';

// --- helpers (mirrors task-mutations.test.ts repo scaffolding) ---

const P = '_test_ps_';
let testCounter = 0;
function nextProject(): string { return `${P}${++testCounter}`; }

function makeRepo(projects: Record<string, string>): { cleanup: () => void; tasksPathFor: (project: string) => string } {
  const dirs: string[] = [];
  for (const [project, content] of Object.entries(projects)) {
    const projectDir = path.join(PROJECTS_DIR, project);
    dirs.push(projectDir);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'TASKS.yaml'), content);
  }
  return {
    tasksPathFor: (project: string) => path.join(PROJECTS_DIR, project, 'TASKS.yaml'),
    cleanup: () => {
      for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    },
  };
}

const BASE_TASK = 'tasks:\n  - id: "p111"\n    text: Big parent task\n    why: w\n    done-when: all parts done\n    priority: medium\n    status: open\n    template: coder-review\n    plan: plans/x.md\n';

// --- Task.parent round-trip ---

test('rawToTask reads parent and defaults it to null', () => {
  const withParent = rawToTask({ id: 'aaaa', text: 't', parent: 'bbbb' }, 'proj');
  assert.equal(withParent.parent, 'bbbb');
  const without = rawToTask({ id: 'aaaa', text: 't' }, 'proj');
  assert.equal(without.parent, null);
});

test('taskToYamlObj emits parent only when set', () => {
  const t = rawToTask({ id: 'aaaa', text: 't', parent: 'bbbb' }, 'proj');
  assert.equal(taskToYamlObj(t).parent, 'bbbb');
  const bare = rawToTask({ id: 'aaaa', text: 't' }, 'proj');
  assert.equal('parent' in taskToYamlObj(bare), false, 'null parent stays hidden in YAML');
});

test('parent survives a serialize → parse round trip', () => {
  const t = rawToTask({ id: 'aaaa', text: 't', parent: 'bbbb' }, 'proj');
  const reparsed = parseTasksFile(serializeTasksFile([t]), 'proj');
  assert.equal(reparsed[0].parent, 'bbbb');
});

// --- decomposeTask keepParent mode ---

test('decomposeTask keepParent keeps the parent as a join node depending on all children', () => {
  const proj = nextProject();
  const { tasksPathFor, cleanup } = makeRepo({ [proj]: BASE_TASK });
  try {
    const result = decomposeTask(proj, null, [
      { key: 'a', text: 'Part A', 'done-when': 'A done' },
      { key: 'b', text: 'Part B', 'depends-on': ['a'] },
    ], 'p111', { keepParent: true });
    assert.equal(result.success, true, result.message);

    const tasks = parseTasksFile(fs.readFileSync(tasksPathFor(proj), 'utf8'), proj);
    assert.equal(tasks.length, 3, 'parent + 2 children');
    const parent = tasks.find(t => t.id === 'p111')!;
    const children = tasks.filter(t => t.parent === 'p111');
    assert.equal(children.length, 2);
    const a = children.find(c => c.text === 'Part A')!;
    const b = children.find(c => c.text === 'Part B')!;
    assert.deepEqual(new Set(parent.depends_on), new Set([a.id, b.id]), 'parent waits on all children');
    assert.deepEqual(b.depends_on, [a.id], 'sibling key dependency resolved to hex id');
    assert.equal(a.template, 'coder-review', 'children inherit template');
    assert.equal(parent.status, 'open', 'parent stays open (becomes the acceptance node)');
  } finally { cleanup(); }
});

test('decomposeTask replace mode passes the grandparent down to keep the tree connected', () => {
  const proj = nextProject();
  const taskWithParent = BASE_TASK.replace('    plan: plans/x.md\n', '    plan: plans/x.md\n    parent: "9999"\n');
  const { tasksPathFor, cleanup } = makeRepo({ [proj]: taskWithParent });
  try {
    const result = decomposeTask(proj, null, [{ text: 'Sub 1' }, { text: 'Sub 2' }], 'p111');
    assert.equal(result.success, true, result.message);
    const tasks = parseTasksFile(fs.readFileSync(tasksPathFor(proj), 'utf8'), proj);
    assert.equal(tasks.length, 2, 'replace mode removes the original');
    for (const t of tasks) assert.equal(t.parent, '9999', 'children inherit grandparent');
  } finally { cleanup(); }
});

test('decomposeTask rejects unknown sibling dependency keys', () => {
  const proj = nextProject();
  const { cleanup } = makeRepo({ [proj]: BASE_TASK });
  try {
    const result = decomposeTask(proj, null, [
      { key: 'a', text: 'A', 'depends-on': ['nope'] },
    ], 'p111', { keepParent: true });
    assert.equal(result.success, false);
    assert.match(result.message, /nope/);
  } finally { cleanup(); }
});

// --- lint: parent integrity ---

function fakeTask(over: Record<string, any>): any {
  return rawToTask({ text: 't', why: 'w', 'done-when': 'd', priority: 'medium', status: 'open', template: 'x', plan: 'p', ...over }, over.project || 'proj');
}

test('lintTasks reports missing-parent when parent references an unknown id', () => {
  const tasks = [fakeTask({ id: 'aaaa', parent: 'gone' })];
  const result = lintTasks(tasks);
  assert.ok(result.errors.some((e: any) => e.code === 'missing-parent' && e.task_id === 'aaaa' && e.missing === 'gone'));
});

test('lintTasks reports parent-cycle for circular parent chains', () => {
  const tasks = [fakeTask({ id: 'aaaa', parent: 'bbbb' }), fakeTask({ id: 'bbbb', parent: 'aaaa' })];
  const result = lintTasks(tasks);
  assert.ok(result.errors.some((e: any) => e.code === 'parent-cycle'));
});

test('lintTasks accepts a healthy parent chain', () => {
  const tasks = [fakeTask({ id: 'aaaa' }), fakeTask({ id: 'bbbb', parent: 'aaaa' })];
  const result = lintTasks(tasks);
  assert.equal(result.errors.some((e: any) => String(e.code).includes('parent')), false);
});

// --- processSplitOutcome (dispatch path) ---

function makeDeps() {
  const calls: { decompose: any[]; unclaim: string[] } = { decompose: [], unclaim: [] };
  return {
    calls,
    deps: {
      detect: (_: string) => ({ split: false, subtasks: null, error: null }),
      decompose: (...args: any[]) => { calls.decompose.push(args); return { success: true, message: 'ok' }; },
      unclaim: async (id: string) => { calls.unclaim.push(id); },
    },
  };
}

test('processSplitOutcome is a no-op when no [SPLIT] marker', async () => {
  const { calls, deps } = makeDeps();
  const r = await processSplitOutcome({ threadId: 'thr_x', taskId: 't111', project: 'proj' }, deps);
  assert.equal(r.handled, false);
  assert.equal(calls.decompose.length, 0);
  assert.equal(calls.unclaim.length, 0);
});

test('processSplitOutcome decomposes keep-parent and unclaims on a valid proposal', async () => {
  const { calls, deps } = makeDeps();
  deps.detect = () => ({ split: true, subtasks: [{ key: 'a', text: 'A' }], error: null });
  const r = await processSplitOutcome({ threadId: 'thr_x', taskId: 't111', project: 'proj' }, deps);
  assert.equal(r.handled, true);
  assert.equal(calls.decompose.length, 1);
  const [proj, text, subtasks, taskId, options] = calls.decompose[0];
  assert.equal(proj, 'proj');
  assert.equal(text, null);
  assert.equal(subtasks.length, 1);
  assert.equal(taskId, 't111');
  assert.deepEqual(options, { keepParent: true });
  assert.deepEqual(calls.unclaim, ['t111']);
  assert.match(r.note || '', /1 subtask/);
});

test('processSplitOutcome surfaces parse errors and still unclaims (no silent drop)', async () => {
  const { calls, deps } = makeDeps();
  deps.detect = () => ({ split: true, subtasks: null, error: 'bad json' });
  const r = await processSplitOutcome({ threadId: 'thr_x', taskId: 't111', project: 'proj' }, deps);
  assert.equal(r.handled, true);
  assert.equal(r.error, 'bad json');
  assert.equal(calls.decompose.length, 0);
  assert.deepEqual(calls.unclaim, ['t111']);
});

test('processSplitOutcome ignores threads without an associated task', async () => {
  const { calls, deps } = makeDeps();
  deps.detect = () => ({ split: true, subtasks: [{ text: 'A' }], error: null });
  const r = await processSplitOutcome({ threadId: 'thr_x', taskId: null, project: 'proj' }, deps);
  assert.equal(r.handled, false);
  assert.equal(calls.decompose.length, 0);
});

test('processSplitOutcome reports decompose failure without unclaiming twice', async () => {
  const { calls, deps } = makeDeps();
  deps.detect = () => ({ split: true, subtasks: [{ text: 'A' }], error: null });
  deps.decompose = (..._args: any[]) => { calls.decompose.push(_args); return { success: false, message: 'lock held' }; };
  const r = await processSplitOutcome({ threadId: 'thr_x', taskId: 't111', project: 'proj' }, deps);
  assert.equal(r.handled, true);
  assert.match(r.error || '', /lock held/);
  assert.deepEqual(calls.unclaim, ['t111'], 'task returned to open exactly once');
});
