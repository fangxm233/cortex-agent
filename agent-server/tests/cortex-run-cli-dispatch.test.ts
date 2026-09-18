import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT_SERVER_DIR } from './module-loader.js';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { parseTasksFile } from '../src/core/task-parser.js';
import { resolveTaskGeneration } from '../src/domain/tasks/system/cortex-run.js';
import { runCli as runTaskCli } from '../src/domain/tasks/system/task-cli.js';

const CORTEX_RUN = path.join(AGENT_SERVER_DIR, 'dist', 'domain', 'tasks', 'system', 'cortex-run.js');
const TASK_CONTEXT_KEYS = [
  'CORTEX_THREAD_ID', 'CORTEX_TASK_ID', 'CORTEX_TASK_PROJECT', 'CORTEX_TASK_GENERATION',
] as const;

function withoutTaskContext<T>(run: () => T): T {
  const previous = Object.fromEntries(TASK_CONTEXT_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of TASK_CONTEXT_KEYS) delete process.env[key];
    return run();
  } finally {
    for (const key of TASK_CONTEXT_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface CortexRunArgsExpected {
  name?: string;
  device?: string;
  command?: string[];
  project?: string | null;
  taskId?: string | null;
  envPassthrough?: string[];
  logTailBytes?: number;
  cancel?: string | null;
  stall?: string;
  gpu?: string;
  force?: boolean;
}

function parseArgsHelper(argv: string[], extraEnv: Record<string, string> = {}): CortexRunArgsExpected {
  const inlineScript = [
    `import { parseCliArgs } from '${CORTEX_RUN}';`,
    `process.argv = ${JSON.stringify(argv)};`,
    `const args = parseCliArgs();`,
    `console.log(JSON.stringify({`,
    `  name: args.name,`,
    `  device: args.device,`,
    `  command: args.command,`,
    `  project: args.project,`,
    `  taskId: args.taskId,`,
    `  envPassthrough: args.envPassthrough,`,
    `  logTailBytes: args.logTailBytes,`,
    `  cancel: args.cancel,`,
    `  stall: args.stall,`,
    `  gpu: args.gpu,`,
    `  force: args.force,`,
    `}));`,
  ].join('\n');

  const result = spawnSync('node', ['--input-type=module', '-e', inlineScript], {
    cwd: AGENT_SERVER_DIR,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `node exited with ${result.status}`);
  }

  // Filter out log lines from module auto-load (e.g. [machine-registry ...])
  // and parse the last JSON line from stdout
  const lines = result.stdout.trim().split('\n').filter(l => !l.trim().startsWith('['));
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine);
}

// ── Argument parsing tests ──

test('resolveTaskGeneration only forwards the matching dispatch ownership', () => {
  const env = {
    CORTEX_TASK_ID: 'a3f2',
    CORTEX_TASK_PROJECT: 'atlas',
    CORTEX_TASK_GENERATION: 'generation-b',
  };
  assert.equal(resolveTaskGeneration('atlas', 'a3f2', env), 'generation-b');
  assert.equal(resolveTaskGeneration('atlas', 'ffff', env), null);
  assert.equal(resolveTaskGeneration('other', 'a3f2', env), null);
});

test('unowned cortex-run linkage cannot mark a generated task pending', () => {
  const project = `_test_cr_unowned_${process.pid}`;
  const projectDir = path.join(PROJECTS_DIR, project);
  const tasksPath = path.join(projectDir, 'TASKS.yaml');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(tasksPath, 'tasks:\n  - id: a3f2\n    text: Generated task\n    status: open\n    dispatch-generation: generation-b\n    claimed-by: task-dispatcher\n');
  try {
    const result = withoutTaskContext(() => runTaskCli([
      'pending', '--project', project, '--task-id', 'a3f2',
    ]));
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /generation|ownership/i);
    const task = parseTasksFile(fs.readFileSync(tasksPath, 'utf8'), project)[0];
    assert.equal(task.status, 'open');
    assert.equal(task.claimed_by, 'task-dispatcher');
    assert.equal(task.dispatch_generation, 'generation-b');
    assert.equal(task.pending_at, null);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('parseCliArgs reads --task-project and --task-id', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test-exp', '--task-project', 'example-research', '--task-id', 'a3f2', '--', 'echo', 'hello']);
  assert.equal(args.project, 'example-research');
  assert.equal(args.taskId, 'a3f2');
});

// ── Device offline test ──

test('cortex-run exits with error when device is not online', () => {
  // Run cortex-run as a CLI with no WebSocket server running
  // It should fail at isDeviceOnline check and exit with code 1
  const result = spawnSync('node', [CORTEX_RUN, '--name', 'test-offline', '--device', 'nonexistent-device', '--', 'echo', 'hi'], {
    cwd: AGENT_SERVER_DIR,
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, `should exit with code 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes('not online') || result.stderr.includes('offline') || result.stdout.includes('not online') || result.stdout.includes('offline'),
    `output should mention "not online", got: ${result.stderr || result.stdout}`
  );
});

// ── env-passthrough extraction from process.env ──

// ── Legacy: accepted task-id ──

test('cortex-run rejects unknown --project CLI argument', () => {
  const result = spawnSync('node', ['--input-type=module', '-e',
    `import { parseCliArgs } from '${CORTEX_RUN}';\n` +
    `process.argv = ['node', 'cortex-run', '--name', 'test-exp', '--project', 'foo', '--', 'echo', 'hello'];\n` +
    `const args = parseCliArgs();`
  ], {
    cwd: AGENT_SERVER_DIR,
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, 'should reject --project CLI argument');
});
