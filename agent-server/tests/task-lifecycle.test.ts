// input:  Vitest, unified task CLI, isolated TASKS.yaml fixtures
// output: CLI parsing, lock guards, generation fencing, and round trips
// pos:    Verifies task CLI wiring above lifecycle mutators
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { PROJECTS_DIR, STORE_DIR } from '../src/core/paths.js';
import { runCli } from '../src/domain/tasks/system/task-cli.js';

function readYaml(filePath: string): any {
  return yamlParse(fs.readFileSync(filePath, 'utf8'));
}

function findTask(tasks: any[], id: string): any {
  return tasks.find((t: any) => t.id === id);
}

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

const P = '_test_lc_';
let n = 0;
function np(): string { return `${P}${++n}`; }
// Unique 4-char hex IDs to avoid cross-test contamination (must be valid hex for depends-on validation)
let idSeq = 0x1a00;
function uid(): string { return (++idSeq).toString(16).padStart(4, '0'); }

function runTask(args: string[]) {
  const result = runCli(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'task CLI failed');
  }
  return JSON.parse(result.stdout);
}

/** Acquire a project lock so mutation commands can pass the lock guard. */
function lockProject(project: string): void {
  const result = runCli(['lock-acquire', '--project', project]);
  if (result.exitCode !== 0) {
    throw new Error(`lock-acquire failed: ${result.stderr || result.stdout}`);
  }
}

test('complete clears depends-on dependencies across projects and reports unblocked count', () => {
  const pA = np();
  const pB = np();
  const [idA, idB] = [uid(), uid()];
  const repos = makeRepo({
    [pA]: `tasks:\n  - id: ${idA}\n    text: "Complete me"\n    why: "finish it"\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n    claimed-by: agent\n    claimed-at: "2026-03-13"\n    approval-needed: true\n`,
    [pB]: `tasks:\n  - id: ${idB}\n    text: "Depends on alpha"\n    why: "wait for alpha"\n    done-when: "alpha done"\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n    depends-on: [${idA}]\n`,
  });
  try {
    const result = runTask(['complete', '--project', pA, '--task-id', idA, '--note', 'verified']);
    assert.equal(result.success, true);
    assert.match(result.message, /unblocked 1 dependent task/);

    const alphaParsed = readYaml(repos[pA].tasksPath);
    const alphaTask = findTask(alphaParsed.tasks, idA);
    assert.equal(alphaTask.status, 'done');
    assert.equal(alphaTask['completed-note'], 'verified');
    assert.ok(alphaTask['completed-at']);

    const betaParsed = readYaml(repos[pB].tasksPath);
    const betaTask = findTask(betaParsed.tasks, idB);
    assert.deepEqual(betaTask['depends-on'] || [], []);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('edit replaces fields and --depends-on replaces dependency list', () => {
  const pA = np();
  const pB = np();
  const [id1, id2, id3] = [uid(), uid(), uid()];
  const repos = makeRepo({
    [pA]: `tasks:\n  - id: ${id1}\n    text: "${id1}"\n    why: "finish it"\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n    claimed-by: agent\n    claimed-at: "2026-03-13"\n    approval-needed: true\n  - id: ${id2}\n    text: "Edit me"\n    why: "old why"\n    done-when: "old done"\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
    [pB]: `tasks:\n  - id: ${id3}\n    text: "Depends on alpha"\n    why: "wait for alpha"\n    done-when: "alpha done"\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n    depends-on: [${id1}]\n`,
  });
  try {
    lockProject(pA);
    const result = runTask([
      'edit', '--project', pA, '--task-id', id2,
      '--text', 'Edited task',
      '--why', 'new why',
      '--done-when', 'new done',
      '--priority', 'high',
      '--depends-on', id3,
    ]);

    assert.equal(result.success, true);
    assert.deepEqual(result['updated-fields'].sort(), ['depends-on', 'done-when', 'priority', 'text', 'why']);

    const alphaParsed = readYaml(repos[pA].tasksPath);
    const task = findTask(alphaParsed.tasks, id2);
    assert.equal(task.text, 'Edited task');
    assert.equal(task.why, 'new why');
    assert.equal(task['done-when'], 'new done');
    assert.equal(task.priority, 'high');
    assert.deepEqual(task['depends-on'], [id3]);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('edit incremental dep mutation: --add-depends-on / --remove-depends-on', () => {
  const pA = np();
  const pB = np();
  const [idA1, idA2, idB] = [uid(), uid(), uid()];
  const repos = makeRepo({
    [pA]: `tasks:\n  - id: ${idA1}\n    text: "Task A"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n  - id: ${idA2}\n    text: "Task B"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
    [pB]: `tasks:\n  - id: ${idB}\n    text: "Task C"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n    depends-on: [${idA1}]\n`,
  });
  try {
    lockProject(pB);
    const r1 = runTask(['edit', '--project', pB, '--task-id', idB, '--add-depends-on', idA2]);
    assert.equal(r1.success, true);
    let betaParsed = readYaml(repos[pB].tasksPath);
    let betaTask = findTask(betaParsed.tasks, idB);
    assert.deepEqual(betaTask['depends-on'], [idA1, idA2]);

    const r2 = runTask(['edit', '--project', pB, '--task-id', idB, '--remove-depends-on', idA1]);
    assert.equal(r2.success, true);
    betaParsed = readYaml(repos[pB].tasksPath);
    betaTask = findTask(betaParsed.tasks, idB);
    assert.deepEqual(betaTask['depends-on'], [idA2]);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('edit --clear-depends-on clears all dependencies', () => {
  const pA = np();
  const [idDep1, idDep2, idTask] = [uid(), uid(), uid()];
  const repos = makeRepo({
    [pA]: `tasks:\n  - id: ${idDep1}\n    text: "Dep 1"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n  - id: ${idDep2}\n    text: "Dep 2"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n  - id: ${idTask}\n    text: "Has deps"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n    depends-on: [${idDep1}, ${idDep2}]\n`,
  });
  try {
    lockProject(pA);
    const r1 = runTask(['edit', '--project', pA, '--task-id', idTask, '--clear-depends-on']);
    assert.equal(r1.success, true);
    const parsed = readYaml(repos[pA].tasksPath);
    const task = findTask(parsed.tasks, idTask);
    assert.equal(task['depends-on'] || undefined, undefined);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('add accepts --depends-on with space-separated values', () => {
  const proj = np();
  const [id1, id2] = [uid(), uid()];
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${id1}\n    text: "Existing"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n  - id: ${id2}\n    text: "Existing 2"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
  });
  try {
    lockProject(proj);
    const result = runTask([
      'add', '--project', proj,
      '--text', 'New dependent task',
      '--why', 'depends on existing',
      '--done-when', 'both done',
      '--priority', 'high',
      '--template', 'coder-review',
      '--depends-on', id1, id2,
    ]);

    assert.equal(result.success, true);
    const parsed = readYaml(repos[proj].tasksPath);
    const task = findTask(parsed.tasks, result['task-id']);
    assert.ok(task);
    assert.deepEqual(task['depends-on'], [id1, id2]);
    assert.equal(task.priority, 'high');
    assert.equal(task.template, 'coder-review');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('add accepts --depends-on as repeatable flag', () => {
  const proj = np();
  const [id1, id2] = [uid(), uid()];
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${id1}\n    text: "Existing"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n  - id: ${id2}\n    text: "Existing 2"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
  });
  try {
    lockProject(proj);
    const result = runTask([
      'add', '--project', proj,
      '--text', 'Repeatable',
      '--why', 'mixed',
      '--done-when', 'all done',
      '--priority', 'medium',
      '--template', 'coder-review',
      '--depends-on', id1,
      '--depends-on', id2,
    ]);

    assert.equal(result.success, true);
    const parsed = readYaml(repos[proj].tasksPath);
    const task = findTask(parsed.tasks, result['task-id']);
    assert.deepEqual(task['depends-on'], [id1, id2]);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('stop requires --task-id', () => {
  const result = runCli(['stop']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--task-id is required/);
});

test('stop returns error for unknown task ID', () => {
  const result = runCli(['stop', '--task-id', 'zzzz']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /No running dispatched task found/);
});

test('--help returns help text with commands and examples', () => {
  const result = runCli(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /claim/);
  assert.match(result.stdout, /complete/);
  assert.match(result.stdout, /Examples:/);
  assert.match(result.stdout, /Options:/);
  assert.match(result.stdout, /--project/);
  assert.match(result.stdout, /--depends-on/);
  assert.doesNotMatch(result.stdout, /qa-pending/);
});

test('unknown command lists available commands', () => {
  const result = runCli(['nonexistent']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown command: 'nonexistent'/);
  assert.match(result.stderr, /Available commands:/);
  assert.match(result.stderr, /claim/);
});

test('complete returns task_id in result', () => {
  const proj = np();
  const tid = uid();
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${tid}\n    text: "Complete me"\n    why: "finish it"\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n    claimed-by: agent\n    claimed-at: "2026-03-13"\n    approval-needed: true\n`,
  });
  try {
    const result = runTask(['complete', '--project', proj, '--task-id', tid, '--note', 'done']);
    assert.equal(result.success, true);
    assert.equal(result['task-id'], tid);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('complete uses dispatch generation from env and rejects a stale execution', () => {
  const proj = np();
  const tid = uid();
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${tid}\n    text: "Reworked task"\n    why: "finish it"\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n    claimed-by: task-dispatcher\n    claimed-at: "2026-03-13"\n    dispatch-generation: generation-b\n`,
  });
  const keys = ['CORTEX_THREAD_ID', 'CORTEX_TASK_ID', 'CORTEX_TASK_PROJECT', 'CORTEX_TASK_GENERATION'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CORTEX_THREAD_ID = 'thr_stale';
    process.env.CORTEX_TASK_ID = tid;
    process.env.CORTEX_TASK_PROJECT = proj;
    process.env.CORTEX_TASK_GENERATION = 'generation-a';
    const stalePending = runCli(['pending', '--project', proj, '--task-id', tid]);
    assert.equal(stalePending.exitCode, 1);
    const stalePause = runCli(['pause', '--project', proj, '--task-id', tid]);
    assert.equal(stalePause.exitCode, 1);
    let task = findTask(readYaml(repos[proj].tasksPath).tasks, tid);
    assert.equal(task.status, 'open');
    assert.equal(task['claimed-by'], 'task-dispatcher');

    const stale = runCli(['complete', '--project', proj, '--task-id', tid, '--note', 'old SHA aaaaaaa']);
    assert.equal(stale.exitCode, 1);
    task = findTask(readYaml(repos[proj].tasksPath).tasks, tid);
    assert.equal(task.status, 'open');
    assert.equal(task['dispatch-generation'], 'generation-b');

    const staleByText = runCli([
      'complete', '--project', proj, '--task', 'Reworked task', '--note', 'old text-selector SHA',
    ]);
    assert.equal(staleByText.exitCode, 1);
    task = findTask(readYaml(repos[proj].tasksPath).tasks, tid);
    assert.equal(task.status, 'open');
    assert.equal(task['completed-note'] ?? null, null);

    process.env.CORTEX_TASK_GENERATION = 'generation-b';
    const current = runTask(['complete', '--project', proj, '--task-id', tid, '--note', 'current SHA bbbbbbb']);
    assert.equal(current.success, true);
    task = findTask(readYaml(repos[proj].tasksPath).tasks, tid);
    assert.equal(task.status, 'done');
    assert.equal(task['completed-note'], 'current SHA bbbbbbb');

    process.env.CORTEX_TASK_GENERATION = 'generation-a';
    const staleUncomplete = runCli(['uncomplete', '--project', proj, '--task-id', tid]);
    assert.equal(staleUncomplete.exitCode, 1);
    task = findTask(readYaml(repos[proj].tasksPath).tasks, tid);
    assert.equal(task.status, 'done');
    assert.equal(task['completed-note'], 'current SHA bbbbbbb');
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('claim returns task_id, agent, and claimed_at', () => {
  const proj = np();
  const tid = uid();
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${tid}\n    text: "Task"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
  });
  try {
    const result = runTask(['claim', '--project', proj, '--task-id', tid, '--agent', 'test-agent']);
    assert.equal(result.success, true);
    assert.equal(result['task-id'], tid);
    assert.equal(result.agent, 'test-agent');
    assert.ok(result['claimed-at']);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('stale stop metadata cannot unclaim a newer dispatch generation', () => {
  const proj = np();
  const tid = uid();
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${tid}\n    text: "Reclaimed task"\n    why: ""\n    done-when: done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n    claimed-by: task-dispatcher\n    claimed-at: "2026-03-13"\n    dispatch-generation: generation-b\n`,
  });
  const pendingPath = path.join(STORE_DIR, 'pending-tasks.json');
  const backup = fs.existsSync(pendingPath) ? fs.readFileSync(pendingPath, 'utf8') : null;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(pendingPath, JSON.stringify({
      'old-dispatch': {
        taskHash: tid, project: proj, machine: 'test', dispatchGeneration: 'generation-a',
      },
    }));
    const result = runCli(['stop', '--task-id', 'old-dispatch']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Stale task dispatch generation/);
    const task = findTask(readYaml(repos[proj].tasksPath).tasks, tid);
    assert.equal(task['claimed-by'], 'task-dispatcher');
    assert.equal(task['dispatch-generation'], 'generation-b');
  } finally {
    if (backup === null) fs.rmSync(pendingPath, { force: true });
    else fs.writeFileSync(pendingPath, backup);
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('stop --dry-run returns preview without executing', () => {
  const result = runCli(['stop', '--task-id', 'zzzz', '--dry-run']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /No running dispatched task found/);
});

test('add rejects unknown flags', () => {
  const proj = np();
  const tid = uid();
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${tid}\n    text: "Existing"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
  });
  try {
    const result = runCli([
      'add', '--project', proj,
      '--text', 'Task without idempotency',
      '--why', 'test',
      '--done-when', 'done',
      '--template', 'coder-review',
      '--idempotency-key', 'removed-flag',
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unknown argument: --idempotency-key/);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

// ── Lock CLI tests ──

test('lock-acquire acquires a project lock', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n  - id: aaaa\n    text: "x"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n' });
  try {
    const result = runTask(['lock-acquire', '--project', proj]);
    assert.equal(result.success, true);
    assert.equal(result.project, proj);
    assert.ok(result.owner);
    assert.ok(result['acquired-at']);
    assert.ok(result['expires-at']);
    assert.equal(result['ttl-minutes'], 20);
    assert.equal(result.force, false);

    // Lock persisted in YAML
    const parsed = readYaml(repos[proj].tasksPath);
    assert.ok(parsed.lock);
    assert.equal(parsed.lock.owner, result.owner);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-acquire with --force overrides existing lock', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    // First acquire
    runTask(['lock-acquire', '--project', proj]);

    // Second acquire without --force should fail
    const r2 = runCli(['lock-acquire', '--project', proj]);
    assert.equal(r2.exitCode, 1);
    const r2Parsed = JSON.parse(r2.stdout);
    assert.equal(r2Parsed.success, false);
    assert.match(r2Parsed.message, /Lock held/);

    // Force override should succeed
    const r3 = runTask(['lock-acquire', '--project', proj, '--force']);
    assert.equal(r3.success, true);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-acquire with --note persists note in lock state', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    const result = runTask(['lock-acquire', '--project', proj, '--note', 'restructuring']);
    assert.equal(result.success, true);

    const parsed = readYaml(repos[proj].tasksPath);
    assert.equal(parsed.lock.note, 'restructuring');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-release releases a lock', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    runTask(['lock-acquire', '--project', proj]);
    const result = runTask(['lock-release', '--project', proj]);
    assert.equal(result.success, true);

    const parsed = readYaml(repos[proj].tasksPath);
    assert.ok(!parsed.lock);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-release with --force releases lock', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    runTask(['lock-acquire', '--project', proj]);
    const result = runTask(['lock-release', '--project', proj, '--force']);
    assert.equal(result.success, true);

    const parsed = readYaml(repos[proj].tasksPath);
    assert.ok(!parsed.lock);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-release reports lock owner/acquired_at/expires_at before release', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    runTask(['lock-acquire', '--project', proj]);
    const result = runTask(['lock-release', '--project', proj]);
    assert.equal(result.success, true);
    assert.ok(result.owner);
    assert.ok(result['acquired-at']);
    assert.ok(result['expires-at']);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-status shows single project lock', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    runTask(['lock-acquire', '--project', proj]);
    const result = runCli(['lock-status', '--project', proj]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /LOCKED/);
    assert.match(result.stdout, new RegExp(proj));
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-status --json outputs structured JSON', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    runTask(['lock-acquire', '--project', proj]);
    const result = runCli(['lock-status', '--project', proj, '--json']);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.project, proj);
    assert.ok(parsed.owner);
    assert.ok(parsed['acquired-at']);
    assert.ok(parsed['expires-at']);
    assert.equal(parsed['ttl-minutes'], 20);
    assert.equal(parsed.force, false);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-status without --project lists all projects', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    runTask(['lock-acquire', '--project', proj]);
    const result = runCli(['lock-status']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(proj));
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-force-release force-releases a lock', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    runTask(['lock-acquire', '--project', proj]);
    const result = runTask(['lock-force-release', '--project', proj]);
    assert.equal(result.success, true);
    assert.equal(result.force, true);

    const parsed = readYaml(repos[proj].tasksPath);
    assert.ok(!parsed.lock);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock guard: edit without lock fails with lock-required message', () => {
  const proj = np();
  const [id1] = [uid()];
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${id1}\n    text: "Edit me"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
  });
  try {
    const result = runCli(['edit', '--project', proj, '--task-id', id1, '--text', 'new']);
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, false);
    assert.match(parsed.message, /Lock required/);
    assert.match(parsed.message, /lock-acquire/);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock guard: add without lock fails', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    const result = runCli(['add', '--project', proj, '--text', 'new task', '--template', 'coder-review']);
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, false);
    assert.match(parsed.message, /Lock required/);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock guard: batch-edit without lock fails', () => {
  const proj = np();
  const [id1] = [uid()];
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${id1}\n    text: "Task"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
  });
  try {
    const result = runCli(['batch-edit', '--project', proj, '--task-ids', id1, '--text', 'new']);
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, false);
    assert.match(parsed.message, /Lock required/);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock guard: decompose without lock fails', () => {
  const proj = np();
  const [id1] = [uid()];
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ${id1}\n    text: "Parent"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
  });
  try {
    const result = runCli(['decompose', '--project', proj, '--task-id', id1, '--subtasks-file', '/dev/null']);
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, false);
    assert.match(parsed.message, /Lock required/);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock guard: assign-ids without lock fails', () => {
  const proj = np();
  const repos = makeRepo({
    [proj]: `tasks:\n  - id: ""\n    text: "No id"\n    why: ""\n    done-when: ""\n    priority: medium\n    status: open\n    template: coder-review\n    plan: ""\n`,
  });
  try {
    const result = runCli(['assign-ids', '--project', proj]);
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, false);
    assert.match(parsed.message, /Lock required/);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-acquire --json outputs structured JSON', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    const result = runTask(['lock-acquire', '--project', proj, '--json']);
    assert.equal(result.success, true);
    assert.ok(result.owner);
    assert.ok(result['acquired-at']);
    assert.ok(result['expires-at']);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('lock-acquire uses fixed 20min TTL', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    const result = runTask(['lock-acquire', '--project', proj]);
    const acquired = new Date(result['acquired-at']).getTime();
    const expires = new Date(result['expires-at']).getTime();
    const diffSec = (expires - acquired) / 1000;
    // Fixed TTL = 1_200_000ms = 1200s (20min), allow 5s tolerance
    assert.ok(Math.abs(diffSec - 1200) < 5);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

// ── Provenance capture + context-aware project + spawn (Problem 1 & 2) ──

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

test('add captures origin session/channel/thread from env', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    lockProject(proj);
    withEnv({ CORTEX_SESSION_ID: 'sess-1', SLACK_CHANNEL: 'C999', CORTEX_THREAD_ID: 'thr_p' }, () => {
      const result = runTask(['add', '--project', proj, '--template', 'coder-review', '--text', 'origin task', '--done-when', 'd']);
      assert.equal(result.success, true);
    });
    const yaml = readYaml(repos[proj].tasksPath);
    const t = yaml.tasks[0];
    assert.equal(t['origin-session-id'], 'sess-1');
    assert.equal(t['origin-channel'], 'C999');
    assert.equal(t['origin-thread-id'], 'thr_p');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('add --no-notify suppresses origin capture', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    lockProject(proj);
    withEnv({ CORTEX_SESSION_ID: 'sess-1', SLACK_CHANNEL: 'C999' }, () => {
      const result = runTask(['add', '--project', proj, '--template', 'coder-review', '--text', 'no-notify task', '--done-when', 'd', '--no-notify']);
      assert.equal(result.success, true);
    });
    const yaml = readYaml(repos[proj].tasksPath);
    const t = yaml.tasks[0];
    assert.equal(t['origin-session-id'], undefined);
    assert.equal(t['origin-channel'], undefined);
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('add falls back to CORTEX_PROJECT when --project omitted', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    lockProject(proj);
    withEnv({ CORTEX_PROJECT: proj, CORTEX_SESSION_ID: undefined, SLACK_CHANNEL: undefined }, () => {
      const result = runTask(['add', '--template', 'coder-review', '--text', 'env-project task', '--done-when', 'd']);
      assert.equal(result.success, true);
    });
    const yaml = readYaml(repos[proj].tasksPath);
    assert.equal(yaml.tasks.length, 1);
    assert.equal(yaml.tasks[0].text, 'env-project task');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('spawn creates a child of the current task (CORTEX_TASK_ID) and makes parent a join node', () => {
  const proj = np();
  const parentId = uid();
  const repos = makeRepo({ [proj]: `tasks:\n  - id: ${parentId}\n    text: "Parent"\n    why: "w"\n    done-when: "d"\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n` });
  try {
    lockProject(proj);
    let childId = '';
    withEnv({ CORTEX_TASK_ID: parentId, CORTEX_TASK_PROJECT: proj, CORTEX_PROJECT: proj }, () => {
      const result = runTask(['spawn', '--text', 'child work', '--done-when', 'child done']);
      assert.equal(result.success, true);
      childId = result['child-id'] || (result['child-ids'] && result['child-ids'][0]);
      assert.ok(childId, 'spawn must return a child id');
    });
    const yaml = readYaml(repos[proj].tasksPath);
    const child = findTask(yaml.tasks, childId);
    assert.ok(child, 'child task must exist');
    assert.equal(child.parent, parentId);
    assert.equal(child.template, 'coder-review', 'child inherits parent template');
    // child carries no origin (thread-wait path owns resumption)
    assert.equal(child['origin-session-id'], undefined);
    const parent = findTask(yaml.tasks, parentId);
    assert.ok((parent['depends-on'] || []).includes(childId), 'parent becomes a join node depending on the child');
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});

test('spawn without a current task id errors', () => {
  const proj = np();
  const repos = makeRepo({ [proj]: 'tasks:\n' });
  try {
    withEnv({ CORTEX_TASK_ID: undefined, CORTEX_TASK_PROJECT: undefined, CORTEX_PROJECT: proj }, () => {
      const result = runCli(['spawn', '--text', 'orphan', '--done-when', 'd']);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr + result.stdout, /current task|CORTEX_TASK_ID|--task-id/);
    });
  } finally {
    for (const r of Object.values(repos)) r.cleanup();
  }
});
