// input:  core hook-exec runner, Node subprocess fixtures
// output: hook process output, exit-code, timeout, and stdin tests
// pos:    shared hook subprocess runner regression coverage
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHookProcess } from '../src/core/hook-exec.js';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'hook-exec-test-'));

function runNode(script: string, timeoutMs = 1_000) {
  return runHookProcess({
    command: 'node -e',
    args: [script],
    timeoutMs,
    stdinPayload: '',
    label: 'node hook fixture',
  });
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('captures trimmed stdout and the last 2000 stderr characters on success', async () => {
  const result = await runNode([
    "process.stdout.write('  hook output\\n');",
    "process.stderr.write('prefix-' + 'x'.repeat(2100));",
  ].join(''));

  assert.deepEqual(result, {
    stdout: 'hook output',
    stderr: 'x'.repeat(2000),
    exitCode: 0,
  });
});

test('returns captured output and the real non-zero exit code', async () => {
  const result = await runNode(
    "process.stdout.write('partial'); process.stderr.write('bad hook'); process.exit(7);",
  );

  assert.deepEqual(result, {
    stdout: 'partial',
    stderr: 'bad hook',
    exitCode: 7,
    error: 'exited with code 7',
  });
});

test('returns a timeout error when the child is terminated with SIGTERM', async () => {
  const result = await runHookProcess({
    command: 'exec sleep',
    args: ['10'],
    timeoutMs: 25,
    stdinPayload: '',
    label: 'timeout hook fixture',
  });

  assert.deepEqual(result, {
    stdout: '',
    stderr: '',
    exitCode: null,
    error: 'timed out after 25ms',
  });
});

test('resolves a spawn error when the shell interpreter cannot be found', async () => {
  const result = await runHookProcess({
    command: 'true',
    timeoutMs: 1_000,
    stdinPayload: '',
    env: { ...process.env, PATH: path.join(tmpRoot, 'missing-path') },
    label: 'missing shell fixture',
  });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, null);
  assert.match(result.error ?? '', /ENOENT/);
});

test('delivers every stdin payload byte before EOF', async () => {
  const payload = ' line one\nline two \nμ\n';
  const result = await runHookProcess({
    command: 'node -e',
    args: [
      "const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk));" +
      "process.stdin.on('end', () => { const input = Buffer.concat(chunks);" +
      "process.stdout.write(JSON.stringify({ hex: input.toString('hex'), bytes: input.length })); });",
    ],
    timeoutMs: 1_000,
    stdinPayload: payload,
    label: 'stdin hook fixture',
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.stdout), {
    hex: Buffer.from(payload).toString('hex'),
    bytes: Buffer.byteLength(payload),
  });
});

test('passes configured args to the hook command as positional values', async () => {
  const scriptPath = path.join(tmpRoot, 'args.sh');
  writeFileSync(scriptPath, "printf '%s|%s|%s' \"$1\" \"$2\" \"$3\"\n");

  const result = await runHookProcess({
    command: `sh ${JSON.stringify(scriptPath)}`,
    args: ['first value', 'second', '$(not-executed)'],
    timeoutMs: 1_000,
    stdinPayload: '',
    label: 'args hook fixture',
  });

  assert.deepEqual(result, {
    stdout: 'first value|second|$(not-executed)',
    stderr: '',
    exitCode: 0,
  });
});
