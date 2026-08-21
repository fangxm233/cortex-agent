// input:  cli.ts init with a JSON answers file, temporary CORTEX_HOME
// output: machine init, local UI, and usage-choice verification
// pos:    Init --answers integration tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_TS = path.join(TEST_ROOT, 'src', 'entry', 'cli.ts');
const NODE = process.execPath;

const liveChildren = new Set<ChildProcess>();
const tempDirs: string[] = [];

afterAll(() => {
  for (const child of liveChildren) {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  liveChildren.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[], timeoutMs = 120_000): Promise<{
  stdout: string; stderr: string; exitCode: number | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, ['--import', 'tsx', CLI_TS, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    liveChildren.add(child);
    child.on('close', () => liveChildren.delete(child));

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cortex ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function makeHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-init-answers-'));
  tempDirs.push(dir);
  return dir;
}

/** Parse the NDJSON event stream; asserts every stdout line is a JSON object. */
function parseEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout.split('\n').filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`stdout line ${index + 1} is not JSON — human output must go to stderr: ${line}`);
    }
  });
}

test('init --answers --json emits an NDJSON event stream and enables the local UI', async () => {
  const home = makeHome();
  const answersFile = path.join(home, 'answers.json');
  writeFileSync(answersFile, JSON.stringify({
    lang: 'en',
    backends: ['claude'],
    machineName: 'testbox',
    gpuCount: 0,
    platforms: [],
    installService: false,
    localUi: { enabled: true, port: 4123 },
  }));

  const result = await runCli([
    'init',
    '--home', home,
    '--gateway-config-dir', path.join(home, 'aistatus'),
    '--answers', answersFile,
    '--json',
  ]);

  assert.equal(result.exitCode, 0, `init failed\nstderr: ${result.stderr}`);

  const events = parseEvents(result.stdout);
  const steps = events.map((e) => e.step);
  assert.ok(steps.includes('home'), `expected a home step, got ${steps.join(', ')}`);
  assert.ok(steps.includes('config'), `expected a config step, got ${steps.join(', ')}`);
  assert.ok(steps.includes('local-ui'), `expected a local-ui step, got ${steps.join(', ')}`);

  const final = events.at(-1)!;
  assert.equal(final.step, 'result', 'the last event must be the result object');
  assert.equal(final.home, home);
  assert.equal(final.uiUrl, 'http://127.0.0.1:4123');
  assert.match(String(final.clientToken), /^[0-9a-f]{64}$/);
  assert.equal(typeof final.version, 'string');

  const env = dotenv.parse(readFileSync(path.join(home, 'config', '.env'), 'utf-8'));
  assert.equal(env.CORTEX_MACHINE, 'testbox');
  assert.equal(env.CORTEX_UI_HTTP, '1');
  assert.equal(env.CORTEX_UI_PORT, '4123');
  assert.equal(env.CORTEX_CLIENT_TOKEN, final.clientToken);
  assert.equal(env.CORTEX_PLATFORM, undefined, 'no platform selected → no CORTEX_PLATFORM key');

  const settings = JSON.parse(readFileSync(path.join(home, 'config', 'settings.json'), 'utf-8'));
  assert.ok(
    (settings.uiCorsOrigins as string[]).includes('cortexui://localhost'),
    'the native shell origin must be allowed',
  );
});

test('non-interactive init preserves gateway usage when no answer is supplied', async () => {
  const home = makeHome();
  const gatewayDir = path.join(home, 'aistatus');
  const configPath = path.join(gatewayDir, 'config.yaml');
  const original = 'name: test-user\nuploadEnabled: true\n';
  mkdirSync(gatewayDir, { recursive: true });
  writeFileSync(configPath, original);

  const result = await runCli([
    'init', '--home', home, '--gateway-config-dir', gatewayDir, '--json',
  ]);

  assert.equal(result.exitCode, 0, `init failed\nstderr: ${result.stderr}`);
  assert.equal(readFileSync(configPath, 'utf-8'), original);
});

test('init --answers applies an explicit gateway usage opt-out', async () => {
  const home = makeHome();
  const gatewayDir = path.join(home, 'aistatus');
  const configPath = path.join(gatewayDir, 'config.yaml');
  const answersFile = path.join(home, 'answers.json');
  mkdirSync(gatewayDir, { recursive: true });
  writeFileSync(configPath, 'name: test-user\nuploadEnabled: true\n');
  writeFileSync(answersFile, JSON.stringify({ gatewayUsage: { enabled: false } }));

  const result = await runCli([
    'init', '--home', home, '--gateway-config-dir', gatewayDir, '--answers', answersFile, '--json',
  ]);

  assert.equal(result.exitCode, 0, `init failed\nstderr: ${result.stderr}`);
  assert.match(readFileSync(configPath, 'utf-8'), /uploadEnabled: false/);
});

test('init --answers rejects a malformed answers file without touching the home', async () => {
  const home = makeHome();
  const answersFile = path.join(home, 'answers.json');
  writeFileSync(answersFile, '{ not json');

  const result = await runCli([
    'init', '--home', home, '--answers', answersFile, '--json',
  ], 60_000);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not valid JSON/);
});
