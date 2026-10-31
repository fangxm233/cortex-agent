import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLAUDE_CONFIG_HOME, CONFIG_DIR } from '../src/core/paths.js';
import { CONNECTIONS_FILE, upsertConnection } from '../src/core/connections-file.js';
import { dropRoutingEnv, getSavedApiEnv } from '../src/domain/auth/anthropic-env.js';
import { resolveClaudeRoute } from '../src/domain/connections/claude-route.js';
import { importFresh } from './helpers/fresh-module.js';

// The daemon's own environment and saved credentials. Per-spawn routing itself (which variables a
// connection sets and unsets) is covered by tests/domain/connections/claude-route.test.ts.

type Cleanup = { onTestFinished: (fn: () => void) => void };

const ROUTE_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT'];

function readOptionalFile(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

function restoreFile(file: string, contents: string | undefined): void {
  if (contents === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, contents);
}

/** Clear the route variables from process.env and seed CONFIG_DIR/.env; both restored after. */
function withSavedEnv(t: Cleanup, dotenv: string): void {
  const envFile = path.join(CONFIG_DIR, '.env');
  const files = [envFile, CONNECTIONS_FILE].map(file => [file, readOptionalFile(file)] as const);
  const env = Object.fromEntries(ROUTE_ENV_KEYS.map(key => [key, process.env[key]]));
  t.onTestFinished(() => {
    for (const [file, contents] of files) restoreFile(file, contents);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of ROUTE_ENV_KEYS) delete process.env[key];
  fs.rmSync(CONNECTIONS_FILE, { force: true });
  fs.writeFileSync(envFile, dotenv);
}

/** Pins the Claude-owned credential probe to Cortex's own Claude config dir (inside this test
 *  file's temp home), so the result never depends on the machine. */
function pinClaudeCredential(t: Cleanup, owned: boolean): void {
  const file = path.join(CLAUDE_CONFIG_HOME, '.credentials.json');
  t.onTestFinished(() => fs.rmSync(file, { force: true }));
  fs.rmSync(file, { force: true });
  if (!owned) return;
  fs.mkdirSync(CLAUDE_CONFIG_HOME, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } }),
    { mode: 0o600 },
  );
}

test('importing the credential and route modules does NOT mutate the routing env (no module side effect)', async (t) => {
  withSavedEnv(t, '');
  process.env.ANTHROPIC_API_KEY = 'sk-import-probe';
  process.env.ANTHROPIC_BASE_URL = 'https://import-probe.example.test';

  for (const modulePath of [
    '../src/domain/auth/anthropic-env.js',
    '../src/domain/connections/claude-route.js',
    '../src/domain/agents/config.js',
  ]) await importFresh(new URL(modulePath, import.meta.url));

  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-import-probe',
    'importing these modules must not delete/rewrite ANTHROPIC_API_KEY');
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://import-probe.example.test',
    'importing these modules must not delete/rewrite ANTHROPIC_BASE_URL');
});

test('resolveClaudeRoute decides without touching process.env', (t) => {
  withSavedEnv(t, '');
  upsertConnection({
    id: 'api', backend: 'claude', label: 'API', authStyle: 'x-api-key', key: 'sk-ant-fixture-pure', billing: 'metered',
  });
  process.env.ANTHROPIC_API_KEY = 'sk-probe-untouched';
  process.env.ANTHROPIC_BASE_URL = 'https://probe.example.test';

  for (const connection of ['subscription', 'api', null]) resolveClaudeRoute(connection);

  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-probe-untouched');
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://probe.example.test');
});

test('getSavedApiEnv reads the api connection, not a key left in .env', (t) => {
  withSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-dotenv"\n');
  assert.equal(getSavedApiEnv().ANTHROPIC_API_KEY, undefined,
    'a pre-connections .env key is the migration\'s input, not a saved credential');

  upsertConnection({
    id: 'api', backend: 'claude', label: 'API', baseUrl: 'https://relay.example.test',
    authStyle: 'x-api-key', key: 'sk-ant-fixture-connection', billing: 'metered',
  });
  assert.equal(getSavedApiEnv().ANTHROPIC_API_KEY, 'sk-ant-fixture-connection');
  assert.equal(getSavedApiEnv().ANTHROPIC_BASE_URL, 'https://relay.example.test');
});

test('getSavedApiEnv reports the legacy OAuth token with its expiry only when they belong together', (t) => {
  withSavedEnv(t, 'CLAUDE_CODE_OAUTH_TOKEN="oat-fixture-legacy"\n'
    + 'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT="1893456000000"\n');
  assert.equal(getSavedApiEnv().CLAUDE_CODE_OAUTH_TOKEN, 'oat-fixture-legacy');
  assert.equal(getSavedApiEnv().CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT, '1893456000000');

  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-fixture-shell';
  assert.equal(getSavedApiEnv().CLAUDE_CODE_OAUTH_TOKEN, 'oat-fixture-shell', 'the environment wins');
  assert.equal(getSavedApiEnv().CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT, undefined,
    'the saved expiry describes the saved token, not the one from the environment');
});

test('dropRoutingEnv leaves the daemon no endpoint or key to leak into a child', (t) => {
  withSavedEnv(t, '');
  pinClaudeCredential(t, false);
  const env: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: 'sk-ant-fixture-daemon', ANTHROPIC_AUTH_TOKEN: 'fixture-relay-token',
    ANTHROPIC_BASE_URL: 'https://inherited.example.test', PATH: '/usr/bin',
  };

  dropRoutingEnv(env);

  assert.deepEqual(env, { PATH: '/usr/bin' },
    'every spawn takes its endpoint and key from its connection; nothing else may be inherited');
});

test('dropRoutingEnv keeps the legacy OAuth token while Claude owns no credential', (t) => {
  withSavedEnv(t, '');
  pinClaudeCredential(t, false);
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: 'oat-fixture-legacy', CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: '1893456000000',
  };

  dropRoutingEnv(env);

  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oat-fixture-legacy',
    'without a Claude-owned credential the static token is the subscription credential');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT, '1893456000000');
});

test('dropRoutingEnv drops the legacy OAuth token once Claude owns the credential', (t) => {
  withSavedEnv(t, '');
  pinClaudeCredential(t, true);
  const env: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: 'sk-ant-fixture-arbitration',
    CLAUDE_CODE_OAUTH_TOKEN: 'oat-fixture-legacy', CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: '1893456000000',
  };

  dropRoutingEnv(env);

  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined,
    'the static copy may not shadow the token claude login refreshes');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT, undefined,
    'an expiry without its token is a stale claim about a credential that is not there');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});
