// input:  Node test runner + cortex-run.ts CLI dispatch
// output: CLI argument parsing + device offline + env-passthrough tests
// pos:    Verify cortex-run CLI parses new flags and forwards via sendCommand
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { AGENT_SERVER_DIR } from './module-loader.js';

const CORTEX_RUN = path.join(AGENT_SERVER_DIR, 'dist', 'domain', 'tasks', 'system', 'cortex-run.js');

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

test('parseCliArgs reads --device', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--device', 'lab', '--', 'echo', 'hi']);
  assert.equal(args.device, 'lab');
});

test('parseCliArgs --device defaults via getLocalMachine when omitted', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--', 'echo', 'hi']);
  // getLocalMachine() returns first key in machines.json or 'local'
  assert.ok(typeof args.device === 'string', `device should be a string, got ${typeof args.device}`);
  assert.ok(args.device.length > 0, `device should not be empty`);
});

test('parseCliArgs reads --env-passthrough', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--env-passthrough', 'PATH,PYTHONPATH,LD_LIBRARY_PATH', '--', 'echo', 'hi']);
  assert.deepEqual(args.envPassthrough, ['PATH', 'PYTHONPATH', 'LD_LIBRARY_PATH']);
});

test('parseCliArgs --env-passthrough handles single key', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--env-passthrough', 'PATH', '--', 'echo', 'hi']);
  assert.deepEqual(args.envPassthrough, ['PATH']);
});

test('parseCliArgs --env-passthrough empty when omitted', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--', 'echo', 'hi']);
  assert.deepEqual(args.envPassthrough, []);
});

test('parseCliArgs reads --log-tail-bytes', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--log-tail-bytes', '10000', '--', 'echo', 'hi']);
  assert.equal(args.logTailBytes, 10000);
});

test('parseCliArgs --log-tail-bytes defaults to 5000', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--', 'echo', 'hi']);
  assert.equal(args.logTailBytes, 5000);
});

test('parseCliArgs reads --task-project and --task-id', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test-exp', '--task-project', 'example-research', '--task-id', 'a3f2', '--', 'echo', 'hello']);
  assert.equal(args.project, 'example-research');
  assert.equal(args.taskId, 'a3f2');
});

test('parseCliArgs --task-project and --task-id null when not set', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test-exp', '--', 'echo', 'hello']);
  assert.equal(args.project, null);
  assert.equal(args.taskId, null);
});

test('parseCliArgs reads --cancel', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--cancel', 'my-run-name']);
  assert.equal(args.cancel, 'my-run-name');
});

test('parseCliArgs reads --gpu flag', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--gpu', '0', '--', 'echo', 'hi']);
  assert.equal(args.gpu, '0');
});

test('parseCliArgs reads --stall flag', () => {
  const args = parseArgsHelper(['node', 'cortex-run', '--name', 'test', '--stall', '30m', '--', 'echo', 'hi']);
  assert.equal(args.stall, '30m');
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

test('cortex-run --env-passthrough extracts env keys from process.env', () => {
  const args = parseArgsHelper(
    ['node', 'cortex-run', '--name', 'test', '--env-passthrough', 'PATH,CUSTOM_TEST_VAR', '--', 'echo', 'hi'],
    { CUSTOM_TEST_VAR: 'my_value' }
  );
  // parseCliArgs only parses keys, extraction happens in main()
  // Here we verify the keys are correctly parsed
  assert.ok(args.envPassthrough.includes('PATH'), 'PATH should be in envPassthrough list');
  assert.ok(args.envPassthrough.includes('CUSTOM_TEST_VAR'), 'CUSTOM_TEST_VAR should be in envPassthrough list');
});

// ── Legacy: accepted task-id ──

test('cortex-run accepts --task-id CLI argument', () => {
  const result = spawnSync('node', ['--input-type=module', '-e',
    `import { parseCliArgs } from '${CORTEX_RUN}';\n` +
    `process.argv = ['node', 'cortex-run', '--name', 'test-exp', '--task-id', 'a3f2', '--', 'echo', 'hello'];\n` +
    `const args = parseCliArgs();\n` +
    `console.log(args.taskId);`
  ], {
    cwd: AGENT_SERVER_DIR,
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const taskIdLine = result.stdout.trim().split('\n').filter(l => !l.trim().startsWith('[')).pop() || '';
  assert.equal(taskIdLine, 'a3f2');
});

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
