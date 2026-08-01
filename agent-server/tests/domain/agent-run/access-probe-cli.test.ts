// input:  probe CLI, supervisor, strace, Node fixture
// output: help, errors, JSON, and human summary
// pos:    Standalone access-probe CLI regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../../src/domain/agent-run/access-probe-cli.ts', import.meta.url));
const ENTRY = fileURLToPath(new URL('./access-probe-fixture.mjs', import.meta.url));
const INSTALL_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX = createRequire(import.meta.url).resolve('tsx');
let root = '';

beforeAll(() => {
  const result = spawnSync('flock', [
    '-x', '/tmp/cortex-supervisor-build.lock', 'npm', 'run', 'build:supervisor',
  ], { cwd: INSTALL_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'access-probe-cli-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    stream.on('end', () => resolve(output));
    stream.on('error', reject);
  });
}

async function run(args: string[]) {
  const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = collect(child.stdout!);
  const stderr = collect(child.stderr!);
  const code = await new Promise<number | null>(resolve => child.once('close', resolve));
  return { code, stdout: await stdout, stderr: await stderr };
}

it('prints copyable help without running a probe', async () => {
  const result = await run(['--help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: node .*access-probe-cli/);
  assert.match(result.stdout, /Examples:/);
  assert.match(result.stdout, /mkdir -p \/tmp\/cortex-access-probe\/workspace/);
  assert.doesNotMatch(result.stdout, /--workspace \/workspace/);
  assert.equal(result.stderr, '');
});

it('rejects an unknown option with valid alternatives', async () => {
  const result = await run(['--unknown', 'value']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option: '--unknown'/);
  assert.match(result.stderr, /Valid values:/);
  assert.equal(result.stdout, '');
});

it('emits one JSON verdict on stdout and a human summary on stderr', async () => {
  const trialRoot = path.join(root, 'trial');
  const workspace = path.join(root, 'workspace');
  const hostHome = path.join(root, 'host');
  const hostCortexHome = path.join(hostHome, '.cortex');
  fs.mkdirSync(workspace);
  fs.mkdirSync(hostCortexHome, { recursive: true });
  const result = await run([
    '--trial-root', trialRoot,
    '--workspace', workspace,
    '--entry', ENTRY,
    '--install-root', INSTALL_ROOT,
    '--host-home', hostHome,
    '--host-cortex-home', hostCortexHome,
    '--entry-arg', 'clean',
    '--entry-arg', path.join(trialRoot, 'logs'),
    '--entry-arg', path.join(hostCortexHome, 'unused'),
  ]);

  assert.equal(result.code, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.violations, []);
  assert.match(result.stderr, /^Access probe OK:/);
});
