// input:  real supervisor binary, hostile fixture, Linux /proc
// output: static-build and process-containment contract evidence
// pos:    End-to-end verification of the native supervisor
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import {
  BUILD_MANIFEST,
  SERVER_ROOT,
  SUPERVISOR_BIN,
  SUPERVISOR_ROOT,
  assertNoToken,
  binaryDigest,
  buildSupervisor,
  cleanupTrackedTokensSync,
  fileSize,
  releaseToken,
  removeTestRoot,
  runEscapeScenario,
  sourceDigest,
  startSupervisor,
  testRootPrefix,
  type ProtocolRecord,
} from './supervisor-harness.js';

interface BuildManifest {
  schema_version: string;
  artifact: string;
  source_files: string[];
  source_sha256: string;
  binary_sha256: string;
  target_arch: string;
  target_triple: string;
  compiler: string;
  libc: { name: string; version: string; linkage: string };
}

const EXPECTED_SOURCE_FILES = [
  'build.sh',
  'src/cli.c',
  'src/cli.h',
  'src/main.c',
  'src/process-tree.c',
  'src/process-tree.h',
  'src/protocol.c',
  'src/protocol.h',
  'src/supervisor.c',
  'src/supervisor.h',
];

let testRoot = '';
let fixtureHelper = '';

beforeAll(() => {
  testRoot = mkdtempSync(testRootPrefix());
  fixtureHelper = buildSupervisor(testRoot);
});

afterEach(cleanupTrackedTokensSync);

afterAll(() => {
  cleanupTrackedTokensSync();
  if (testRoot) removeTestRoot(testRoot);
});

function records(result: { control: ProtocolRecord[] }, type: ProtocolRecord['type']): ProtocolRecord[] {
  return result.control.filter((record) => record.type === type);
}

function assertKeys(record: ProtocolRecord, expected: string[]): void {
  assert.deepEqual(Object.keys(record).sort(), expected.sort());
}

function assertTimestamp(record: ProtocolRecord): void {
  assert.match(String(record.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Number.isFinite(Date.parse(String(record.ts))));
}

function assertSuccessfulProtocol(control: ProtocolRecord[]): void {
  assert.deepEqual(control.map((record) => record.type), ['started', 'exited', 'quiescent']);
  assertKeys(control[0], ['v', 'type', 'pid', 'pgid', 'ts']);
  assertKeys(control[1], ['v', 'type', 'code', 'signal', 'ts']);
  assertKeys(control[2], ['v', 'type', 'descendants', 'ts']);
  for (const record of control) {
    assert.equal(record.v, 1);
    assertTimestamp(record);
  }
  assert.equal(control[0].pid, control[0].pgid);
  assert.equal(control[2].descendants, 0);
}

function expectedExit(trigger: string): number {
  if (trigger === 'normal') return 0;
  if (trigger === 'deadline') return 124;
  return 130;
}

function runCli(args: string[]) {
  return spawnSync(SUPERVISOR_BIN, args, {
    cwd: testRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
}

test('build command emits a static binary and independently verifiable manifest', () => {
  const manifest = JSON.parse(readFileSync(BUILD_MANIFEST, 'utf8')) as BuildManifest;
  assert.equal(manifest.schema_version, 'cortex-supervisor-build/1');
  assert.equal(manifest.artifact, 'dist/cortex-supervisor');
  assert.deepEqual(manifest.source_files, EXPECTED_SOURCE_FILES);
  assert.deepEqual(manifest.source_files, [...manifest.source_files].sort());
  assert.equal(manifest.source_sha256, sourceDigest(manifest.source_files));
  assert.equal(manifest.binary_sha256, binaryDigest());
  assert.ok(fileSize(SUPERVISOR_BIN) > 0);
  assert.equal(manifest.target_arch, spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim());
  assert.equal(manifest.target_triple, spawnSync('gcc', ['-dumpmachine'], { encoding: 'utf8' }).stdout.trim());
  assert.match(manifest.compiler, /^gcc /);
  assert.deepEqual(manifest.libc, {
    name: 'glibc',
    version: spawnSync('getconf', ['GNU_LIBC_VERSION'], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[1],
    linkage: 'static',
  });
  const ldd = spawnSync('ldd', [SUPERVISOR_BIN], { encoding: 'utf8' });
  assert.match(`${ldd.stdout}${ldd.stderr}`, /not a dynamic executable/);
});

for (const trigger of ['normal', 'sigterm', 'deadline', 'cancel-close', 'cancel-byte'] as const) {
  test(`${trigger} contains env-isolated setsid double-fork descendants`, async () => {
    const result = await runEscapeScenario(testRoot, fixtureHelper, trigger);
    assert.equal(result.exitCode, expectedExit(trigger), result.stderr);
    assert.equal(result.signal, null);
    assertSuccessfulProtocol(result.control);
    assert.equal(records(result, 'quiescent').length, 1);
    assert.ok(result.mutationAtExit.length > 0);
    assert.equal(result.mutationAfterExit, result.mutationAtExit, 'workspace changed after supervisor exit');
    assert.ok(readFileSync(path.join(result.workspace, 'term-observed'), 'utf8').includes('term'));
    await assertNoToken(result.token);
    releaseToken(result.token);
  });
}

test('control reporting failure still contains the full tree and exits 125', async () => {
  const result = await runEscapeScenario(testRoot, fixtureHelper, 'control-failure');
  assert.equal(result.exitCode, 125, result.stderr);
  assert.equal(result.signal, null);
  assert.ok(result.mutationAtExit.length > 0);
  assert.equal(result.mutationAfterExit, result.mutationAtExit, 'workspace changed after reporting failure');
  await assertNoToken(result.token);
  releaseToken(result.token);
});

test('child stdio, environment, and non-zero exit pass through unchanged', async () => {
  const running = startSupervisor([
    '--control-fd', '3', '--grace-ms', '20', '--', '/bin/sh', '-c',
    'read value; printf "out:%s:%s\\n" "$value" "$PASS_VALUE"; printf "err:%s\\n" "$PASS_VALUE" >&2; exit 42',
  ], { cwd: testRoot, env: { ...process.env, PASS_VALUE: 'inherited' } });
  running.child.stdin?.end('input\n');
  const result = await running.result;
  assert.equal(result.exitCode, 42);
  assert.equal(result.stdout, 'out:input:inherited\n');
  assert.equal(result.stderr, 'err:inherited\n');
  assertSuccessfulProtocol(result.control);
  assert.equal(result.control[1].code, 42);
  assert.equal(result.control[1].signal, null);
});

test('natural child signal is reported with a null code and signal name', async () => {
  const running = startSupervisor([
    '--control-fd', '3', '--grace-ms', '20', '--', '/bin/sh', '-c', 'kill -TERM $$',
  ], { cwd: testRoot });
  const result = await running.result;
  assert.equal(result.exitCode, 143);
  assertSuccessfulProtocol(result.control);
  assert.equal(result.control[1].code, null);
  assert.equal(result.control[1].signal, 'SIGTERM');
});

test('cancel byte delivered before child exit is latched as cancelled', async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const running = startSupervisor([
      '--control-fd', '3', '--cancel-fd', '4', '--grace-ms', '0', '--', '/bin/cat',
    ], { cwd: testRoot });
    running.cancel!.write('cancel');
    running.child.stdin?.end();
    const result = await running.result;
    assert.equal(result.exitCode, 130, `attempt ${attempt}: ${JSON.stringify(result.control)}`);
    assertSuccessfulProtocol(result.control);
  }
});

test('supervised command inherits default SIGPIPE semantics', async () => {
  const running = startSupervisor([
    '--control-fd', '3', '--grace-ms', '20', '--', '/bin/sh', '-c',
    'kill -PIPE $$; printf survived-sigpipe',
  ], { cwd: testRoot });
  const result = await running.result;
  assert.equal(result.exitCode, 141);
  assert.equal(result.stdout, '');
  assertSuccessfulProtocol(result.control);
  assert.equal(result.control[1].code, null);
  assert.equal(result.control[1].signal, 'SIGPIPE');
});

test('reports canonical names for terminating Linux signals', async () => {
  const running = startSupervisor([
    '--control-fd', '3', '--grace-ms', '20', '--', '/bin/sh', '-c', 'kill -USR1 $$',
  ], { cwd: testRoot });
  const result = await running.result;
  assert.equal(result.exitCode, 138);
  assertSuccessfulProtocol(result.control);
  assert.equal(result.control[1].code, null);
  assert.equal(result.control[1].signal, 'SIGUSR1');
});

test('rejects stdio fd aliases, channel aliases, and invalid unsigned integers', () => {
  const marker = path.join(testRoot, 'invalid-cli-command-ran');
  const command = ['--', '/bin/sh', '-c', `printf ran > ${JSON.stringify(marker)}`];
  const cases: Array<{ args: string[]; error: RegExp }> = [
    { args: ['--control-fd', '0', ...command], error: /control-fd.*greater than 2/i },
    { args: ['--control-fd', '1', ...command], error: /control-fd.*greater than 2/i },
    { args: ['--control-fd', '2', ...command], error: /control-fd.*greater than 2/i },
    { args: ['--control-fd', '3', '--cancel-fd', '0', ...command], error: /cancel-fd.*greater than 2/i },
    { args: ['--control-fd', '3', '--cancel-fd', '1', ...command], error: /cancel-fd.*greater than 2/i },
    { args: ['--control-fd', '3', '--cancel-fd', '2', ...command], error: /cancel-fd.*greater than 2/i },
    { args: ['--control-fd', '3', '--cancel-fd', '3', ...command], error: /must use different descriptors/i },
    { args: ['--control-fd', '3', '--grace-ms', '-1', ...command], error: /non-negative integer/i },
    { args: ['--control-fd', '3', '--grace-ms', '+1', ...command], error: /non-negative integer/i },
    { args: ['--control-fd', '3', '--deadline-ms', ' 1', ...command], error: /non-negative integer/i },
    { args: ['--control-fd', '3', '--deadline-ms', '1x', ...command], error: /non-negative integer/i },
    { args: ['--control-fd', '3', '--deadline-ms', '', ...command], error: /non-negative integer/i },
    { args: ['--control-fd', '3', '--deadline-ms', '18446744073709551616', ...command], error: /non-negative integer/i },
  ];
  for (const entry of cases) {
    const result = runCli(entry.args);
    assert.equal(result.status, 125, `${entry.args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, entry.error);
  }
  assert.equal(existsSync(marker), false);
});

test('help contains a copyable command that opens the control descriptor', () => {
  const help = spawnSync(SUPERVISOR_BIN, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const example = help.stdout.split('\n').map((line) => line.trim())
    .find((line) => line.startsWith('cortex-supervisor --control-fd'));
  assert.ok(example, help.stdout);
  assert.match(example, /3>&1/);
  const executed = spawnSync('/bin/sh', ['-c', example], {
    cwd: testRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.dirname(SUPERVISOR_BIN)}:${process.env.PATH}` },
  });
  assert.equal(executed.status, 0, executed.stderr);
  const records = executed.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.type), ['started', 'exited', 'quiescent']);
});

test('unsupported subreaper path fails closed before spawning the command', async () => {
  const marker = path.join(testRoot, 'unsupported-command-ran');
  const running = startSupervisor([
    '--control-fd', '3', '--', '/bin/sh', '-c', `printf ran > ${JSON.stringify(marker)}`,
  ], {
    cwd: SERVER_ROOT,
    env: { ...process.env, CORTEX_SUPERVISOR_TEST_UNSUPPORTED_PLATFORM: '1' },
  });
  const result = await running.result;
  assert.equal(result.exitCode, 125);
  assert.equal(result.control.length, 1);
  assertKeys(result.control[0], ['v', 'type', 'reason', 'ts']);
  assert.equal(result.control[0].type, 'error');
  assert.equal(result.control[0].reason, 'unsupported_platform');
  assertTimestamp(result.control[0]);
  assert.equal(spawnSync('test', ['-e', marker], { cwd: SUPERVISOR_ROOT }).status, 1);
});
