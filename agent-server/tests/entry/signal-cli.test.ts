import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runSignalCli, parseSignalArgs, type SignalCliOptions } from '../../src/entry/signal-cli.js';

let tmpDir: string;

beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-signal-cli-')); });
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

const ENV = { CORTEX_SIGNAL_ID: 'wp_abcdef123456', CORTEX_SIGNAL_SECRET: 's3cret', WEBHOOK_PORT: '3001' };

function capturing(status = 202, body: any = { accepted: true, fired: true }) {
  const calls: Array<{ url: string; body: any }> = [];
  const options: SignalCliOptions = {
    env: ENV as any,
    post: async (url, payload) => { calls.push({ url, body: payload }); return { status, body }; },
  };
  return { calls, options };
}

// ── argument parsing ───────────────────────────────────────────

test('an unknown flag is a usage error, not a stack trace', async () => {
  const result = await runSignalCli(['--nope', 'x'], { env: ENV as any });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown argument: '--nope'/);
  assert.match(result.stderr, /Valid values/);
});

test('a flag missing its value is a usage error', async () => {
  const result = await runSignalCli(['--id'], { env: ENV as any });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--id requires a value/);
});

test('no arguments and --help both print help and exit 0', async () => {
  for (const argv of [[], ['--help']]) {
    const result = await runSignalCli(argv, { env: ENV as any });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage: cortex-signal/);
    assert.match(result.stdout, /--exit-code/);
  }
});

test('a message starting with -- is still accepted as a value', () => {
  const parsed = parseSignalArgs(['--message', '--weird but valid']);
  assert.equal(parsed.message, '--weird but valid');
});

// ── credentials ────────────────────────────────────────────────

test('the id and secret come from the environment when flags are absent', async () => {
  const { calls, options } = capturing();
  const result = await runSignalCli(['--status', 'ok'], options);
  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].body.id, 'wp_abcdef123456');
  assert.equal(calls[0].body.secret, 's3cret');
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/webhook/signal');
});

test('missing credentials are a usage error that says where to get them', async () => {
  const result = await runSignalCli(['--status', 'ok'], { env: {} as any });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /id and secret are required/);
  assert.match(result.stderr, /wait_create/);
});

// ── --exit-code ────────────────────────────────────────────────

test('--exit-code 0 reports ok and a non-zero code reports fail', async () => {
  const okRun = capturing();
  await runSignalCli(['--exit-code', '0'], okRun.options);
  assert.equal(okRun.calls[0].body.status, 'ok');
  assert.equal(okRun.calls[0].body.message, 'exit=0');

  const failRun = capturing();
  await runSignalCli(['--exit-code', '137'], failRun.options);
  assert.equal(failRun.calls[0].body.status, 'fail');
  assert.equal(failRun.calls[0].body.message, 'exit=137');
});

test('an explicit --message and --status win over the ones --exit-code would derive', async () => {
  const { calls, options } = capturing();
  await runSignalCli(['--exit-code', '1', '--status', 'progress', '--message', 'still going'], options);
  assert.equal(calls[0].body.status, 'progress');
  assert.equal(calls[0].body.message, 'still going');
});

test('a non-numeric --exit-code and an invalid --status are usage errors', async () => {
  const bad = await runSignalCli(['--exit-code', 'nope'], { env: ENV as any });
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr, /--exit-code must be a number/);

  const badStatus = await runSignalCli(['--status', 'maybe'], { env: ENV as any });
  assert.equal(badStatus.exitCode, 2);
  assert.match(badStatus.stderr, /Invalid --status/);
});

// ── data ───────────────────────────────────────────────────────

test('--data @file reads the file and a missing one is reported by name', async () => {
  const file = path.join(tmpDir, 'tail.log');
  await fs.writeFile(file, 'loss 0.412\n');
  const { calls, options } = capturing();
  await runSignalCli(['--data', `@${file}`], options);
  assert.equal(calls[0].body.data, 'loss 0.412\n');

  const missing = await runSignalCli(['--data', '@/no/such/file'], { env: ENV as any });
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /Cannot read --data file/);
});

// ── responses ──────────────────────────────────────────────────

test('an already-resolved waitpoint is success, not a build-breaking failure', async () => {
  const { options } = capturing(410, { accepted: false, state: 'fired' });
  const result = await runSignalCli(['--status', 'ok'], options);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /already resolved \(fired\)/);
});

test('a refused signal exits non-zero and surfaces the reason', async () => {
  const { options } = capturing(401, { accepted: false, error: 'bad secret' });
  const result = await runSignalCli(['--status', 'ok'], options);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /HTTP 401/);
  assert.match(result.stderr, /bad secret/);
});

// ── spool fallback ─────────────────────────────────────────────

test('an unreachable daemon spools the signal to disk and still exits 0', async () => {
  const spoolDir = path.join(tmpDir, 'spool-a');
  const result = await runSignalCli(['--exit-code', '0', '--member', 'arm2'], {
    env: ENV as any,
    spoolDir,
    post: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3001'); },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^spooled /);

  const files = await fs.readdir(spoolDir);
  assert.equal(files.length, 1);
  assert.equal(files[0].endsWith('.json'), true, 'no .tmp may be left behind');
  const payload = JSON.parse(await fs.readFile(path.join(spoolDir, files[0]), 'utf8'));
  assert.deepEqual(payload, { id: 'wp_abcdef123456', secret: 's3cret', status: 'ok', message: 'exit=0', member: 'arm2' });
});

test('--no-spool turns an unreachable daemon into a failure instead', async () => {
  const spoolDir = path.join(tmpDir, 'spool-b');
  const result = await runSignalCli(['--status', 'ok', '--no-spool'], {
    env: ENV as any,
    spoolDir,
    post: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3001'); },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Cannot reach/);
  assert.deepEqual(await fs.readdir(spoolDir).catch(() => []), [], 'nothing may be written when spooling is off');
});
