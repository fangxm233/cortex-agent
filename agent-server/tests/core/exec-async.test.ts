import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runFile, runShell } from '../../src/core/exec-async.js';

test('runFile resolves ok for a zero exit and captures stdout', async () => {
  const result = await runFile(process.execPath, ['-e', 'process.stdout.write("hello")']);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'hello');
});

test('runFile reports a non-zero exit as a value instead of throwing', async () => {
  const result = await runFile(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /boom/);
});

test('runFile reports a missing binary as an error with a null code', async () => {
  const result = await runFile('definitely-not-a-binary-xyz', []);
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.equal(result.timedOut, false);
  assert.ok(result.error, 'spawn failure should be surfaced');
});

test('runFile kills a child that exceeds timeoutMs and flags timedOut', async () => {
  const result = await runFile(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('runFile pipes stdin to the child and closes it', async () => {
  const result = await runFile(
    process.execPath,
    ['-e', 'let data = ""; process.stdin.on("data", (c) => { data += c; }); process.stdin.on("end", () => { process.stdout.write(data.toUpperCase()); });'],
    { stdin: 'abc\n' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'ABC\n');
});

test('runFile closes an empty stdin so a stdin-reading child cannot hang', async () => {
  const result = await runFile(
    process.execPath,
    ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"))'],
    { timeoutMs: 5000 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'eof');
});

test('runShell runs a command line through the shell', async () => {
  const result = await runShell('printf shell-ok');
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'shell-ok');
});

test('runShell surfaces a failing command as a non-zero result', async () => {
  const result = await runShell('exit 7');
  assert.equal(result.ok, false);
  assert.equal(result.code, 7);
});

test('runShell honours cwd and env overrides', async () => {
  const result = await runShell('printf "%s:%s" "$PWD" "$PROBE_VAR"', {
    cwd: '/tmp',
    env: { ...process.env, PROBE_VAR: 'set' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, '/tmp:set');
});
