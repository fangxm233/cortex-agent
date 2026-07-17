// input:  Node test runner + unified task-cli
// output: rich query + deps + lint CLI tests (TASKS.yaml format)
// pos:    Verify task-cli read-path filtering and health report
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { runCli } from '../src/domain/tasks/system/task-cli.js';

const P = '_test_rp_';
let n = 0;
function np(): string { return `${P}${++n}`; }
let idSeq = 0x2a00;
function uid(): string { return (++idSeq).toString(16).padStart(4, '0'); }

function makeRepo(projects: Record<string, string>): Record<string, { tasksPath: string; cleanup: () => void }> {
  const repos: Record<string, { tasksPath: string; cleanup: () => void }> = {};
  for (const [project, content] of Object.entries(projects)) {
    const projectDir = path.join(PROJECTS_DIR, project);
    fs.mkdirSync(projectDir, { recursive: true });
    const tasksPath = path.join(projectDir, 'TASKS.yaml');
    const backup = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : null;
    fs.writeFileSync(tasksPath, content);
    repos[project] = {
      tasksPath,
      cleanup: () => {
        if (backup !== null) fs.writeFileSync(tasksPath, backup);
        else { try { fs.unlinkSync(tasksPath); } catch {} }
        try { fs.rmdirSync(projectDir); } catch {}
      },
    };
  }
  return repos;
}

function runRead(args: string[]): string {
  const result = runCli(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'task CLI failed');
  }
  return result.stdout.trim();
}

function createFixture() {
  const pA = np();
  const pB = np();
  const [a1, a2, a3, a4, a5, a6, a7] = Array.from({ length: 7 }, () => uid());
  const [b1, b2, b3, b4] = Array.from({ length: 4 }, () => uid());
  // b5 is dup1
  const b5 = uid();

  const repos = makeRepo({
    [pA]: `tasks:
  - id: ${a1}
    text: "Ready task"
    why: "Important work"
    done-when: "It is shipped"
    priority: high
    status: open
    template: default
    plan: ""

  - id: ${a2}
    text: "Blocked task"
    why: "Needs approval"
    done-when: "blocker gone"
    priority: medium
    status: open
    template: default
    plan: ""
    blocked-by: waiting

  - id: ${a3}
    text: "Waiting task"
    why: "Depends on beta"
    done-when: "dependency done"
    priority: low
    status: open
    template: default
    plan: ""
    depends-on: [${b1}]

  - id: ${a4}
    text: "Paused gpu task"
    why: "Paused run"
    done-when: "resumed"
    priority: medium
    status: open
    template: default
    plan: ""
    paused: true
    gpu: testbox

  - id: ${a5}
    text: "Missing why task"
    why: ""
    done-when: "add why"
    priority: medium
    status: open
    template: ""
    plan: ""

  - id: ${a6}
    text: "Future gated task"
    why: "Far-future gate"
    done-when: "date has passed"
    priority: low
    status: open
    template: default
    plan: ""
    not-before: "2099-12-31"

  - id: ${a7}
    text: "Past gated task"
    why: "Past gate"
    done-when: "condition met"
    priority: low
    status: open
    template: default
    plan: ""
    not-before: "2020-01-01"

  - text: "No id task"
    why: "Missing id metadata"
    done-when: "assign one"
    priority: low
    status: open
    template: ""
    plan: ""
`,
    [pB]: `tasks:
  - id: ${b1}
    text: "Beta prerequisite"
    why: "unblock alpha"
    done-when: "done"
    priority: medium
    status: open
    template: coder-review
    plan: ""

  - id: ${b2}
    text: "Beta dependent"
    why: "reverse dependency"
    done-when: "a1 complete"
    priority: low
    status: open
    template: default
    plan: ""
    depends-on: [${a1}]

  - id: ${b3}
    text: "Dangling dep"
    why: "bad dependency"
    done-when: "repaired"
    priority: medium
    status: open
    template: default
    plan: ""
    depends-on: [dead]

  - id: ${b4}
    text: "Duplicate id one"
    why: "duplicate case"
    done-when: "first"
    priority: medium
    status: open
    template: ""
    plan: ""

  - id: ${b4}
    text: "Duplicate id two"
    why: "duplicate case two"
    done-when: "second"
    priority: medium
    status: open
    template: ""
    plan: ""
`,
  });
  return { pA, pB, repos, a1, a2, a3, a4, a5, a6, a7, b1, b2, b3, b4 };
}

test('default `list` returns actionable tasks filtered by depends-on completion', () => {
  const { pA, pB, repos, a1, a5, a6, a7, b1, b4 } = createFixture();
  try {
    // Actionable in alpha: a1 (ready), a5 (missing why, but no blockers), a7 (past not-before), no-id task
    const stdoutA = runRead(['list', '--project', pA, '--json']);
    const tasksA = JSON.parse(stdoutA);
    const idsA = tasksA.map((t: any) => t.id);
    assert.ok(idsA.includes(a1), 'ready task should be actionable');
    assert.ok(idsA.includes(a5), 'missing-why task should be actionable');
    assert.ok(idsA.includes(a7), 'past-gated task should be actionable');
    assert.ok(idsA.includes(''), 'no-id task should be actionable');
    assert.ok(!idsA.includes(a6), 'future-gated task should not be actionable');

    // Actionable in beta: b1 (ready), b4 x2 (duplicates)
    const stdoutB = runRead(['list', '--project', pB, '--json']);
    const tasksB = JSON.parse(stdoutB);
    const idsB = tasksB.map((t: any) => t.id);
    assert.ok(idsB.includes(b1), 'beta prerequisite should be actionable');
    assert.equal(idsB.filter((id: string) => id === b4).length, 2, 'both dup tasks should be actionable');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('query filters by status, text, and task id', () => {
  const { pA, pB, repos, a1, a2, b1 } = createFixture();
  try {
    const blocked = JSON.parse(runRead(['query', '--project', pA, '--status', 'blocked', '--json']));
    assert.deepEqual(blocked.map((t: any) => t.id), [a2]);

    const exact = JSON.parse(runRead(['query', '--task-id', a1, '--json']));
    assert.equal(exact.length, 1);
    assert.equal(exact[0].text, 'Ready task');

    const textFilter = JSON.parse(runRead(['query', '--project', pB, '--text', 'prerequisite', '--json']));
    assert.equal(textFilter.length, 1);
    assert.equal(textFilter[0].id, b1);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('show and deps report dependency relationships via depends_on', () => {
  const { repos, a1, b2 } = createFixture();
  try {
    const show = JSON.parse(runRead(['show', '--task-id', a1, '--json']));
    assert.equal(show.task.id, a1);
    assert.equal(show.actionable, true);
    assert.deepEqual(show.dependents, [b2]);

    const deps = JSON.parse(runRead(['deps', '--task-id', b2, '--json']));
    assert.deepEqual(deps.task['depends-on'], [a1]);
    assert.deepEqual(deps.dependents, []);
    assert.deepEqual(deps['depends-on'].map((t: any) => t.id), [a1]);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lint reports duplicates, dangling dependencies, and health warnings', () => {
  const { repos, b3, b4 } = createFixture();
  try {
    const lint = JSON.parse(runRead(['lint', '--json']));

    assert.equal(lint.ok, false);
    assert.ok(lint.errors.some((e: any) => e.code === 'duplicate-id' && e['task-id'] === b4));
    assert.ok(lint.errors.some((e: any) => e.code === 'missing-dependency' && e['task-id'] === b3));
    assert.ok(lint.warnings.some((e: any) => e.code === 'missing-why'));
    assert.ok(lint.warnings.some((e: any) => e.code === 'missing-template'));
    assert.ok(lint.warnings.some((e: any) => e.code === 'missing-id'));
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

// --- help tests ---

test('--help returns help text with read commands and options', () => {
  const result = runCli(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /query/);
  assert.match(result.stdout, /Options:/);
  assert.match(result.stdout, /--status/);
  assert.match(result.stdout, /Examples:/);
});

// --- error message tests ---

test('invalid --status lists valid values', () => {
  const result = runCli(['query', '--status', 'invalid-status']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /invalid --status: 'invalid-status'/);
  assert.match(result.stderr, /Valid values:/);
  assert.match(result.stderr, /actionable/);
  assert.match(result.stderr, /blocked/);
});

test('invalid --priority lists valid values', () => {
  const result = runCli(['query', '--priority', 'urgent']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /invalid --priority: 'urgent'/);
  assert.match(result.stderr, /Valid values:/);
  assert.match(result.stderr, /high/);
});

test('qa statuses removed', () => {
  const r = runCli(['query', '--status', 'qa-pending']);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /invalid --status/);
});

// --- not-before tests ---

test('not-before future date is excluded from actionable list', () => {
  const { pA, repos, a6 } = createFixture();
  try {
    const tasks = JSON.parse(runRead(['list', '--project', pA, '--json']));
    assert.ok(!tasks.some((t: any) => t.id === a6), 'future-gated task must not appear in actionable list');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('not-before past date is included in actionable list', () => {
  const { pA, repos, a7 } = createFixture();
  try {
    const tasks = JSON.parse(runRead(['list', '--project', pA, '--json']));
    assert.ok(tasks.some((t: any) => t.id === a7), 'past-gated task must appear in actionable list');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('query --status actionable excludes future not-before and includes past not-before', () => {
  const { pA, repos, a6, a7 } = createFixture();
  try {
    const tasks = JSON.parse(runRead(['query', '--project', pA, '--status', 'actionable', '--json']));
    assert.ok(!tasks.some((t: any) => t.id === a6), 'future-gated task must not appear');
    assert.ok(tasks.some((t: any) => t.id === a7), 'past-gated task must appear');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

// ── Lock-aware parse / serialize tests ──

import { parseTasksFileWithLock, serializeTasksFileWithLock } from '../src/core/task-parser.js';

test('parseTasksFileWithLock: happy path with lock', () => {
  const yaml = `lock:
  owner: exec_abc
  acquired_at: 2026-01-01T00:00:00Z
  expires_at: 2026-01-01T00:30:00Z
  note: testing
tasks:
  - id: a1
    text: test task
    why: because
    done_when: done
    template: default
    plan: ""
    priority: high
    status: open
    project: p1`;
  const { tasks, lock } = parseTasksFileWithLock(yaml, 'p1');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'a1');
  assert.notEqual(lock, null);
  assert.equal(lock!.owner, 'exec_abc');
  assert.equal(lock!.acquired_at, '2026-01-01T00:00:00Z');
  assert.equal(lock!.expires_at, '2026-01-01T00:30:00Z');
  assert.equal(lock!.note, 'testing');
});

test('parseTasksFileWithLock: no lock field', () => {
  const yaml = `tasks:
  - id: a1
    text: test
    why: w
    done_when: dw
    template: t
    plan: ""
    priority: high
    status: open
    project: p1`;
  const { tasks, lock } = parseTasksFileWithLock(yaml, 'p1');
  assert.equal(tasks.length, 1);
  assert.equal(lock, null);
});

test('parseTasksFileWithLock: empty content', () => {
  const { tasks, lock } = parseTasksFileWithLock('', 'p1');
  assert.deepEqual(tasks, []);
  assert.equal(lock, null);
});

test('parseTasksFileWithLock: whitespace only', () => {
  const { tasks, lock } = parseTasksFileWithLock('  \n  ', 'p1');
  assert.deepEqual(tasks, []);
  assert.equal(lock, null);
});

test('parseTasksFileWithLock: invalid YAML', () => {
  const { tasks, lock } = parseTasksFileWithLock('{{invalid', 'p1');
  assert.deepEqual(tasks, []);
  assert.equal(lock, null);
});

test('parseTasksFileWithLock: lock present but missing required fields', () => {
  const yaml = `lock:
  owner: test
tasks: []`;
  const { tasks, lock } = parseTasksFileWithLock(yaml, 'p1');
  assert.equal(lock, null);
});

test('parseTasksFileWithLock: lock with wrong field types', () => {
  const yaml = `lock:
  owner: test
  acquired_at: 123
  expires_at: 456
tasks: []`;
  const { tasks, lock } = parseTasksFileWithLock(yaml, 'p1');
  assert.equal(lock, null);
});

test('parseTasksFileWithLock: tasks not an array', () => {
  const yaml = `lock:
  owner: test
  acquired_at: 2026-01-01
  expires_at: 2026-01-02
tasks: scalar`;
  const { tasks, lock } = parseTasksFileWithLock(yaml, 'p1');
  assert.deepEqual(tasks, []);
  assert.notEqual(lock, null);
});

test('serializeTasksFileWithLock: with lock outputs lock before tasks', () => {
  const out = serializeTasksFileWithLock({
    tasks: [],
    lock: { owner: 'x', acquired_at: 't1', expires_at: 't2' },
  });
  assert.match(out, /^lock:/);
  assert.match(out, /tasks:/);
  // Verify round-trip
  const { lock } = parseTasksFileWithLock(out, 'p1');
  assert.equal(lock!.owner, 'x');
  assert.equal(lock!.acquired_at, 't1');
  assert.equal(lock!.expires_at, 't2');
});

test('serializeTasksFileWithLock: without lock matches serializeTasksFile output', () => {
  const out = serializeTasksFileWithLock({ tasks: [] });
  assert.equal(out, 'tasks: []\n');
});

test('serializeTasksFileWithLock: lock with note outputs note field', () => {
  const out = serializeTasksFileWithLock({
    tasks: [],
    lock: { owner: 'x', acquired_at: 't1', expires_at: 't2', note: 'my note' },
  });
  assert.match(out, /note: my note/);
});

test('serializeTasksFileWithLock: lock with null is treated as no lock', () => {
  const out = serializeTasksFileWithLock({ tasks: [], lock: null });
  assert.equal(out, 'tasks: []\n');
});

// ── Provenance / origin fields (session→task wake) ──

import { serializeTasksFile, parseTasksFile } from '../src/core/task-parser.js';

function baseTask(overrides: Record<string, any> = {}) {
  return {
    id: 'o1',
    text: 'origin task',
    why: 'w',
    done_when: 'dw',
    priority: 'high' as const,
    status: 'open' as const,
    template: 'default',
    plan: '',
    project: 'p1',
    parent: null,
    depends_on: [] as string[],
    gpu: null,
    gpu_count: 1,
    blocked_by: null,
    claimed_by: null,
    claimed_at: null,
    paused: false,
    approval_needed: false,
    approved_at: null,
    not_before: null,
    completed_at: null,
    completed_note: null,
    pending_at: null,
    origin_session_id: null,
    origin_channel: null,
    origin_thread_id: null,
    ...overrides,
  };
}

test('origin_* fields round-trip through serialize/parse', () => {
  const tasks = [baseTask({
    origin_session_id: 'sess-abc',
    origin_channel: 'C12345',
    origin_thread_id: 'thr_xyz',
  })];
  const yaml = serializeTasksFile(tasks as any);
  // kebab-case keys on disk
  assert.match(yaml, /origin-session-id: sess-abc/);
  assert.match(yaml, /origin-channel: C12345/);
  assert.match(yaml, /origin-thread-id: thr_xyz/);
  const parsed = parseTasksFile(yaml, 'p1');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].origin_session_id, 'sess-abc');
  assert.equal(parsed[0].origin_channel, 'C12345');
  assert.equal(parsed[0].origin_thread_id, 'thr_xyz');
});

test('origin_* null fields are omitted from serialized YAML', () => {
  const yaml = serializeTasksFile([baseTask()] as any);
  assert.ok(!yaml.includes('origin-'), 'null origin fields must not be serialized');
  const parsed = parseTasksFile(yaml, 'p1');
  assert.equal(parsed[0].origin_session_id, null);
  assert.equal(parsed[0].origin_channel, null);
  assert.equal(parsed[0].origin_thread_id, null);
});

test('serializeTasksFileWithLock: round-trip non-empty tasks', () => {
  const tasks = [{
    id: 'a1',
    text: 'test',
    why: 'w',
    done_when: 'dw',
    priority: 'high' as const,
    status: 'open' as const,
    template: 'default',
    plan: '',
    project: 'p1',
    depends_on: [] as string[],
    gpu: null,
    gpu_count: 1,
    blocked_by: null,
    claimed_by: null,
    claimed_at: null,
    paused: false,
    approval_needed: false,
    approved_at: null,
    not_before: null,
    completed_at: null,
    completed_note: null,
    pending_at: null,
    parent: null,
    origin_session_id: null,
    origin_channel: null,
    origin_thread_id: null,
  }];
  const lock = { owner: 'x', acquired_at: 't1', expires_at: 't2' };
  const yaml = serializeTasksFileWithLock({ tasks, lock });
  const parsed = parseTasksFileWithLock(yaml, 'p1');
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].id, 'a1');
  assert.equal(parsed.lock!.owner, 'x');
});
