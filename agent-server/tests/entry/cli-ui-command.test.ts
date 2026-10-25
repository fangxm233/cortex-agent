import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

import { runCli } from '../../src/entry/cli.js';
import { createPairingStore, PAIRING_FILE_NAME } from '../../src/platform/ui-http/ui-pairing.js';

const tempDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ui-cli-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

test('ui enable --json reports the endpoint the native app should connect to', async () => {
  const home = makeHome();

  const result = await runCli(['ui', 'enable', '--home', home, '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.url, 'http://127.0.0.1:3004');
  assert.equal(payload.port, 3004);
  assert.match(payload.token, /^[0-9a-f]{64}$/);
  assert.equal(payload.changed, true);
  assert.equal(payload.home, home);

  const env = dotenv.parse(fs.readFileSync(path.join(home, 'config', '.env'), 'utf-8'));
  assert.equal(env.CORTEX_UI_HTTP, '1');
  assert.equal(env.CORTEX_CLIENT_TOKEN, payload.token);
});

test('ui enable is idempotent — re-running reports changed=false so no restart is needed', async () => {
  const home = makeHome();

  const first = JSON.parse((await runCli(['ui', 'enable', '--home', home, '--json'])).stdout);
  const second = JSON.parse((await runCli(['ui', 'enable', '--home', home, '--json'])).stdout);

  assert.equal(second.changed, false);
  assert.equal(second.token, first.token);
});

test('ui enable --port re-points the endpoint', async () => {
  const home = makeHome();

  const result = await runCli(['ui', 'enable', '--home', home, '--port', '4500', '--json']);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.port, 4500);
  assert.equal(payload.url, 'http://127.0.0.1:4500');
});

test('ui enable rejects an invalid port with the valid range', async () => {
  const home = makeHome();

  const result = await runCli(['ui', 'enable', '--home', home, '--port', 'http']);

  assert.equal(result.exitCode, 1);
});

test('ui enable prints a human summary when --json is absent', async () => {
  const home = makeHome();

  const result = await runCli(['ui', 'enable', '--home', home]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:3004/);
  assert.doesNotMatch(result.stdout, /[0-9a-f]{64}/, 'the token must not be printed in plain output');
});

test('ui pair --json mints a code the server of that home will redeem', async () => {
  const home = makeHome();

  const result = await runCli(['ui', 'pair', '--home', home, '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.match(payload.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(payload.expiresAt > Date.now());
  const server = createPairingStore({ file: path.join(home, 'data', PAIRING_FILE_NAME) });
  assert.equal(server.redeem(payload.code), true);
});

test('ui pair prints the code and where to enter it', async () => {
  const home = makeHome();

  const result = await runCli(['ui', 'pair', '--home', home]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Pairing code: [0-9A-Z]{4}-[0-9A-Z]{4}/);
  assert.match(result.stdout, /10 minutes/);
});

test('ui rejects an unknown subcommand and lists both valid ones', async () => {
  const result = await runCli(['ui', 'bogus']);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /enable/);
  assert.match(result.stderr, /pair/);
});
