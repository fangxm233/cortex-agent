// input:  Vitest, task CLI processes, dispatcher, prompts
// output: Structured task-file, validation, and literal regressions
// pos:    Verifies shell-free task creation through executor prompts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js';
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as yamlParse } from 'yaml';
import { CONFIG_DIR, DEFAULTS_DIR, PROJECTS_DIR } from '../src/core/paths.js';
import { selectAndClaimTask } from '../src/domain/tasks/dispatcher.js';
import { readTaskSpec } from '../src/domain/tasks/system/task-file-input.js';
import { getCliHelp, runCli } from '../src/domain/tasks/system/task-cli.js';
import {
  buildStepPrompt,
  cleanupWorkspace,
  createThread,
  loadConfig,
  mergeThreadTemplates,
  resolveNextStep,
} from '../src/domain/threads/index.js';
import { threadStore } from '../src/store/thread-repo.js';

interface TaskSpec {
  text: string;
  why: string;
  'done-when': string;
  priority?: string;
  template?: string;
}

let sequence = 0;

beforeAll(() => {
  mergeThreadTemplates(
    path.resolve(process.cwd(), 'defaults/config/thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
  );
  loadConfig();
});

function makeProject(tasks = 'tasks:\n'): { project: string; tasksPath: string; cleanup: () => void } {
  const project = `_test_task_file_${++sequence}`;
  const projectDir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(projectDir, { recursive: true });
  const tasksPath = path.join(projectDir, 'TASKS.yaml');
  fs.writeFileSync(tasksPath, tasks);
  return {
    project,
    tasksPath,
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

function runTask(args: string[]): any {
  const result = runCli(args);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function writeSpec(project: string, name: string, spec: TaskSpec): string {
  const filePath = path.join(PROJECTS_DIR, project, name);
  fs.writeFileSync(filePath, JSON.stringify(spec));
  return filePath;
}

function normalizeTaskFields(prompt: string, spec: TaskSpec): string {
  return prompt
    .replace(spec.text, '<text>')
    .replace(spec.why, '<why>')
    .replace(spec['done-when'], '<done-when>');
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('task-file literals survive persistence, dispatch, and the first executor prompt byte-for-byte', async () => {
  const repo = makeProject();
  const literals = '$0 | $36.75 | ${HOME} | $';
  const spec: TaskSpec = {
    text: `text ${literals}`,
    why: `why ${literals}`,
    'done-when': `done ${literals}`,
    priority: 'high',
    template: 'coder-review',
  };
  let threadId: string | null = null;

  try {
    const specPath = writeSpec(repo.project, 'task.json', spec);
    runTask(['lock-acquire', '--project', repo.project]);
    const added = runTask(['add', '--project', repo.project, '--task-file', specPath]);
    runTask(['lock-release', '--project', repo.project]);

    const persisted = yamlParse(fs.readFileSync(repo.tasksPath, 'utf8')).tasks[0];
    assert.equal(persisted.text, spec.text);
    assert.equal(persisted.why, spec.why);
    assert.equal(persisted['done-when'], spec['done-when']);

    const selected = await selectAndClaimTask({ scheduleTaskId: 'literal-regression', dryRun: true });
    assert.ok(selected);
    assert.equal(selected.task.id, added['task-id']);
    assert.ok(selected.prompt.includes(`**Task:** ${spec.text}\n**Why:** ${spec.why}\n**Done when:** ${spec['done-when']}`));

    const thread = createThread('task-file-literal-regression', {
      templateName: selected.template!,
      userMessage: selected.prompt,
      userMessageTs: 'ts',
    });
    threadId = thread.id;
    const next = resolveNextStep(thread.id);
    assert.ok(next);
    const executorPrompt = buildStepPrompt(thread.id, next.agentConfig, next.stage);
    assert.ok(executorPrompt.includes(`**Task:** ${spec.text}\n**Why:** ${spec.why}\n**Done when:** ${spec['done-when']}`));

    const plain: TaskSpec = {
      text: 'plain text',
      why: 'plain why',
      'done-when': 'plain done',
      priority: 'high',
      template: 'coder-review',
    };
    runTask(['lock-acquire', '--project', repo.project]);
    runTask([
      'edit', '--project', repo.project, '--task-id', added['task-id'],
      '--text', plain.text, '--why', plain.why, '--done-when', plain['done-when'],
    ]);
    runTask(['lock-release', '--project', repo.project]);
    const plainSelected = await selectAndClaimTask({ scheduleTaskId: 'literal-regression', dryRun: true });
    assert.ok(plainSelected);
    assert.equal(
      normalizeTaskFields(selected.prompt, spec),
      normalizeTaskFields(plainSelected.prompt, plain),
      'dollar-bearing fields must not alter unrelated dispatch prompt content',
    );
  } finally {
    if (threadId) {
      cleanupWorkspace(threadId);
      await threadStore.delete(threadId);
    }
    repo.cleanup();
  }
});

test('spawn reads child fields from a task file and preserves dollar literals', () => {
  const parentId = 'ab10';
  const repo = makeProject(`tasks:\n  - id: ${parentId}\n    text: Parent\n    why: parent why\n    done-when: parent done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n`);
  const spec: TaskSpec = {
    text: 'child $0 and $',
    why: 'cost $36.75',
    'done-when': 'keep ${HOME}',
  };

  try {
    const specPath = writeSpec(repo.project, 'child.json', spec);
    runTask(['lock-acquire', '--project', repo.project]);
    withEnv({ CORTEX_TASK_ID: parentId, CORTEX_TASK_PROJECT: repo.project }, () => {
      const result = runTask(['spawn', '--task-file', specPath]);
      const tasks = yamlParse(fs.readFileSync(repo.tasksPath, 'utf8')).tasks;
      const child = tasks.find((task: any) => task.id === result['child-id']);
      assert.equal(child.text, spec.text);
      assert.equal(child.why, spec.why);
      assert.equal(child['done-when'], spec['done-when']);
    });
  } finally {
    repo.cleanup();
  }
});

test('task-file accepts stdin and normalizes snake-case task keys', () => {
  const spec = readTaskSpec('-', () => JSON.stringify({
    text: 'stdin $0',
    why: '$36.75',
    done_when: '${HOME} and $',
    depends_on: ['ab10'],
  }));

  assert.deepEqual(spec, {
    text: 'stdin $0',
    why: '$36.75',
    doneWhen: '${HOME} and $',
    plan: null,
    priority: null,
    template: null,
    dependsOn: ['ab10'],
  });
});

test('task-file rejects malformed, non-object, and text-less JSON with actionable errors', () => {
  assert.throws(() => readTaskSpec('-', () => '{'), /Invalid task file JSON/);
  assert.throws(() => readTaskSpec('-', () => '[]'), /single JSON object/);
  assert.throws(() => readTaskSpec('-', () => JSON.stringify({ why: 'missing' })), /text.*required/i);
});

test('task-file rejects mixing structured input with scalar task-spec flags', () => {
  const repo = makeProject();
  try {
    const specPath = writeSpec(repo.project, 'mixed.json', {
      text: 'file text',
      why: 'file why',
      'done-when': 'file done',
    });
    const result = runCli([
      'add', '--project', repo.project, '--task-file', specPath, '--text', 'argument text',
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /cannot be combined.*--text/i);
  } finally {
    repo.cleanup();
  }
});

interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runTaskProcess(
  args: string[],
  input: string,
  env: Record<string, string> = {},
): ProcessResult {
  const cliPath = path.resolve(process.cwd(), 'src/domain/tasks/system/task-cli.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function processPayload(stdout: string): any {
  const objectStart = stdout.lastIndexOf('\n{');
  return JSON.parse(objectStart >= 0 ? stdout.slice(objectStart + 1) : stdout);
}

function parentTasks(parentId: string): string {
  return `tasks:\n  - id: ${parentId}\n    text: Parent\n    why: parent why\n    done-when: parent done\n    priority: high\n    status: open\n    template: coder-review\n    plan: ""\n`;
}

function commandArgs(command: 'add' | 'spawn', project: string, extra: string[] = []): string[] {
  const base = command === 'add' ? ['add', '--project', project] : ['spawn'];
  return [...base, '--task-file', '-', ...extra];
}

function commandEnv(command: 'add' | 'spawn', project: string, parentId: string): Record<string, string> {
  return command === 'spawn'
    ? { CORTEX_TASK_ID: parentId, CORTEX_TASK_PROJECT: project, CORTEX_PROJECT: project }
    : { CORTEX_PROJECT: project };
}

test.each(['add', 'spawn'] as const)('%s consumes a task-file path through the real CLI process', (command) => {
  const parentId = 'ab15';
  const repo = makeProject(command === 'spawn' ? parentTasks(parentId) : 'tasks:\n');
  const spec: TaskSpec = {
    text: 'file $0 and $',
    why: 'file $36.75',
    'done-when': 'file ${HOME}',
    template: 'coder-review',
  };
  try {
    const specPath = writeSpec(repo.project, 'process-task.json', spec);
    const base = command === 'add' ? ['add', '--project', repo.project] : ['spawn'];
    const result = runTaskProcess(
      [...base, '--task-file', specPath, '--auto-lock'],
      '',
      commandEnv(command, repo.project, parentId),
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = processPayload(result.stdout);
    const taskId = command === 'add' ? payload['task-id'] : payload['child-id'];
    const tasks = yamlParse(fs.readFileSync(repo.tasksPath, 'utf8')).tasks;
    const persisted = tasks.find((task: any) => task.id === taskId);
    assert.equal(persisted.text, spec.text);
    assert.equal(persisted.why, spec.why);
    assert.equal(persisted['done-when'], spec['done-when']);
  } finally {
    repo.cleanup();
  }
});

test.each(['add', 'spawn'] as const)('%s consumes task-file stdin through the real CLI and persists literals', (command) => {
  const parentId = 'ab20';
  const repo = makeProject(command === 'spawn' ? parentTasks(parentId) : 'tasks:\n');
  const spec: TaskSpec = {
    text: 'stdin $0 and $',
    why: 'stdin $36.75',
    'done-when': 'stdin ${HOME}',
    template: 'coder-review',
  };
  try {
    const result = runTaskProcess(
      [...commandArgs(command, repo.project), '--auto-lock'],
      JSON.stringify(spec),
      commandEnv(command, repo.project, parentId),
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = processPayload(result.stdout);
    const taskId = command === 'add' ? payload['task-id'] : payload['child-id'];
    const tasks = yamlParse(fs.readFileSync(repo.tasksPath, 'utf8')).tasks;
    const persisted = tasks.find((task: any) => task.id === taskId);
    assert.equal(persisted.text, spec.text);
    assert.equal(persisted.why, spec.why);
    assert.equal(persisted['done-when'], spec['done-when']);
  } finally {
    repo.cleanup();
  }
});

const INVALID_STDIN_CASES = [
  { name: 'malformed JSON', input: '{', extra: [], error: /Invalid task file JSON/ },
  { name: 'non-object JSON', input: '[]', extra: [], error: /single JSON object/ },
  { name: 'missing text', input: '{"why":"missing"}', extra: [], error: /text.*required/i },
  { name: 'mixed scalar input', input: '{"text":"file text"}', extra: ['--text', 'argument text'], error: /cannot be combined.*--text/i },
];

for (const command of ['add', 'spawn'] as const) {
  test.each(INVALID_STDIN_CASES)(`${command} rejects $name without mutating tasks`, ({ input, extra, error }) => {
    const parentId = 'ab30';
    const initial = command === 'spawn' ? parentTasks(parentId) : 'tasks:\n';
    const repo = makeProject(initial);
    try {
      const before = fs.readFileSync(repo.tasksPath, 'utf8');
      const result = runTaskProcess(
        commandArgs(command, repo.project, extra),
        input,
        commandEnv(command, repo.project, parentId),
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, error);
      assert.equal(fs.readFileSync(repo.tasksPath, 'utf8'), before);
    } finally {
      repo.cleanup();
    }
  });
}

test('agent-facing task-file examples require per-execution staging paths', () => {
  const taskSkill = fs.readFileSync(
    path.join(DEFAULTS_DIR, 'plugins/cortex-stage-gate/skills/task/SKILL.md'),
    'utf8',
  );
  const manager = fs.readFileSync(path.join(DEFAULTS_DIR, 'prompts/directives/manager.md'), 'utf8');
  const compound = fs.readFileSync(
    path.join(DEFAULTS_DIR, 'plugins/cortex-common/skills/compound-simple/SKILL.md'),
    'utf8',
  );
  const guidance = [taskSkill, manager, compound, getCliHelp()].join('\n');

  assert.doesNotMatch(guidance, /\/tmp\/task\.json\b/);
  assert.match(taskSkill, /current-thread-or-session-id/);
  assert.match(manager, /<your Task ID>-<child-id>/);
  assert.match(getCliHelp(), /cortex-task-<unique-id>\.json/);
});
