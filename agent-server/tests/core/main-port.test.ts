import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAIN_PORT, envFilePath, mainPortUrl, parsePort, resolveClientToken, resolveMainPort, warnRetiredPortEnv,
} from '../../src/core/main-port.js';

function homeWithEnv(text: string | null): string {
  const home = mkdtempSync(path.join(tmpdir(), 'main-port-'));
  mkdirSync(path.join(home, 'config'), { recursive: true });
  if (text !== null) writeFileSync(path.join(home, 'config', '.env'), text);
  return home;
}

test('parsePort accepts 1..65535 and nothing else', () => {
  assert.equal(parsePort('26789'), 26789);
  assert.equal(parsePort(' 3004 '), 3004);
  for (const bad of [undefined, '', '0', '65536', '-1', '30.5', 'abc', '80abc']) assert.equal(parsePort(bad), null, String(bad));
});

test('the process env wins over the home .env', () => {
  const home = homeWithEnv('CORTEX_UI_PORT=3004\n');
  assert.equal(resolveMainPort({ CORTEX_HOME: home, CORTEX_UI_PORT: '27000' }), 27000);
});

test('the home .env is read when the env has no port (a CLI from a plain shell)', () => {
  const home = homeWithEnv('CORTEX_UI_HTTP=1\nCORTEX_UI_PORT=3004\n');
  assert.equal(resolveMainPort({ CORTEX_HOME: home }), 3004);
  assert.equal(mainPortUrl({ CORTEX_HOME: home }), 'http://127.0.0.1:3004');
});

test('the default applies when neither names a usable port', () => {
  assert.equal(resolveMainPort({ CORTEX_HOME: homeWithEnv(null) }), DEFAULT_MAIN_PORT);
  assert.equal(resolveMainPort({ CORTEX_HOME: homeWithEnv('CORTEX_UI_PORT=nope\n') }), DEFAULT_MAIN_PORT);
  assert.equal(resolveMainPort({ CORTEX_HOME: homeWithEnv('CORTEX_UI_PORT=3004\n'), CORTEX_UI_PORT: '0' }), 3004);
});

test('file: null never reads a .env, so server-spawned code cannot pick up another home', () => {
  const home = homeWithEnv('CORTEX_UI_PORT=3004\n');
  assert.equal(resolveMainPort({ CORTEX_HOME: home }, null), DEFAULT_MAIN_PORT);
  assert.equal(mainPortUrl({ CORTEX_HOME: home, CORTEX_UI_PORT: '27001' }, null), 'http://127.0.0.1:27001');
});

test('the retired port variables are ignored', () => {
  const home = homeWithEnv(null);
  assert.equal(resolveMainPort({ CORTEX_HOME: home, WEBHOOK_PORT: '3001', CORTEX_TUI_PORT: '3003' }), DEFAULT_MAIN_PORT);
});

test('a retired port variable is reported once per process', () => {
  const warnings: string[] = [];
  const env = { CORTEX_HOME: homeWithEnv(null), WEBHOOK_PORT: '3001' };
  warnRetiredPortEnv(env, (m) => warnings.push(m));
  warnRetiredPortEnv(env, (m) => warnings.push(m));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WEBHOOK_PORT is no longer used/);
  assert.match(warnings[0], new RegExp(String(DEFAULT_MAIN_PORT)));
});

test('the client token falls back to the home .env', () => {
  const home = homeWithEnv('CORTEX_CLIENT_TOKEN=from-file\n');
  assert.equal(resolveClientToken({ CORTEX_HOME: home }), 'from-file');
  assert.equal(resolveClientToken({ CORTEX_HOME: home, CORTEX_CLIENT_TOKEN: 'from-env' }), 'from-env');
  assert.equal(envFilePath({ CORTEX_HOME: home }), path.join(home, 'config', '.env'));
});
