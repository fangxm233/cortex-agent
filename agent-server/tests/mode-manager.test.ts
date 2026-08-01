// input:  Node test runner, mode config, gateway mock
// output: mode routing, saved-key, and fallback tests
// pos:    Verify mode-manager routing and credential policy
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from '../src/core/paths.js';
import { importFresh } from './module-loader.js';

// Standard import (no cache buster) — same singleton instance that mode-manager uses
import { _testSetHealthy, GATEWAY_URL } from './../src/domain/costs/gateway-manager.js';

test('configureEnvForMode(api) encodes mode in URL when gateway healthy', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;

  t.onTestFinished(() => {
    _testSetHealthy(null);
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
  });

  _testSetHealthy(true);
  const modeManager = await importFresh('./../src/domain/agents/index.js');

  process.env.ANTHROPIC_API_KEY = 'sk-test-late';
  process.env.ANTHROPIC_BASE_URL = 'https://late.example.test';
  modeManager.configureEnvForMode('api');

  assert.equal(process.env.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/api/anthropic`,
    'api mode should encode mode in URL path: /m/api/anthropic');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test-late',
    'api mode should KEEP the API key so Claude Code passes its startup credential check — upstream auth is handled by the gateway');
});

test('configureEnvForMode(api) sets placeholder key when no key available and gateway healthy', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;

  t.onTestFinished(() => {
    _testSetHealthy(null);
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
  });

  _testSetHealthy(true);
  // Import config.js itself fresh: it owns the savedApiEnv module state, and the barrel's
  // cache-buster does not propagate to it (a previous test's key would otherwise stick).
  const modeManager = await importFresh('./../src/domain/agents/config.js');
  delete process.env.ANTHROPIC_API_KEY; // module import may have mutated env

  modeManager.configureEnvForMode('api');

  assert.equal(typeof modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER, 'string',
    'GATEWAY_MANAGED_KEY_PLACEHOLDER must be exported');
  assert.ok(modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER.length > 0, 'placeholder must be non-empty');
  assert.equal(process.env.ANTHROPIC_API_KEY, modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER,
    'with no saved key, a placeholder must be set so Claude Code can start on machines without OAuth login');
});

test('configureEnvForMode(non-plan custom mode) keeps API key when gateway healthy', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;

  t.onTestFinished(() => {
    _testSetHealthy(null);
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
  });

  _testSetHealthy(true);
  const modeManager = await importFresh('./../src/domain/agents/index.js');

  process.env.ANTHROPIC_API_KEY = 'sk-test-custom';
  modeManager.configureEnvForMode('qwen-ksu');

  assert.equal(process.env.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/qwen-ksu/anthropic`,
    'custom mode should encode mode in URL path');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test-custom',
    'non-plan modes should keep the API key — only plan mode requires the OAuth bearer path');
});

test('placeholder key never leaks into saved env (gateway healthy → unhealthy)', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;

  t.onTestFinished(() => {
    _testSetHealthy(null);
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
  });

  _testSetHealthy(true);
  // Fresh config.js (state owner) — see placeholder test above for why not the barrel.
  const modeManager = await importFresh('./../src/domain/agents/config.js');
  delete process.env.ANTHROPIC_API_KEY;

  // Healthy + no real key → placeholder lands in process.env
  modeManager.configureEnvForMode('api');
  assert.equal(typeof modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER, 'string',
    'GATEWAY_MANAGED_KEY_PLACEHOLDER must be exported');
  assert.equal(process.env.ANTHROPIC_API_KEY, modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER);

  // Gateway goes down → direct fallback must NOT treat the placeholder as a real saved key
  _testSetHealthy(false);
  modeManager.configureEnvForMode('api');
  assert.notEqual(process.env.ANTHROPIC_API_KEY, modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER,
    'direct fallback must not send the placeholder to api.anthropic.com');
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined,
    'no real key was ever available, so direct fallback should have no key');
});

test('getSavedApiEnv ignores a gateway placeholder persisted in dotenv', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const envFile = path.join(CONFIG_DIR, '.env');
  const originalFile = readOptionalFile(envFile);
  delete process.env.ANTHROPIC_API_KEY;
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=cortex-gateway-managed\n');
  t.onTestFinished(() => { restoreApiKey(originalApiKey); restoreFile(envFile, originalFile); });

  const modeManager = await importFresh('./../src/domain/agents/config.js');

  assert.equal(modeManager.getSavedApiEnv().ANTHROPIC_API_KEY, undefined);
});

test('a live gateway placeholder cannot replace a real key saved in dotenv', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const envFile = path.join(CONFIG_DIR, '.env');
  const originalFile = readOptionalFile(envFile);
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY="sk-ant-fixture-saved"\n');
  process.env.ANTHROPIC_API_KEY = 'cortex-gateway-managed';
  _testSetHealthy(true);
  t.onTestFinished(() => {
    restoreApiKey(originalApiKey); restoreFile(envFile, originalFile); _testSetHealthy(null);
  });

  const modeManager = await importFresh('./../src/domain/agents/config.js');
  modeManager.configureEnvForMode('api');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-fixture-saved');
  _testSetHealthy(false);
  modeManager.configureEnvForMode('api');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-fixture-saved');
});

function readOptionalFile(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

function restoreFile(file: string, contents: string | undefined): void {
  if (contents === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, contents);
}

function restoreApiKey(value: string | undefined): void {
  if (value === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = value;
}

test('configureEnvForMode(plan) encodes mode in URL when gateway healthy', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  process.env.ANTHROPIC_API_KEY = 'sk-test-plan';
  process.env.ANTHROPIC_BASE_URL = 'https://managed.example.test';

  t.onTestFinished(() => {
    _testSetHealthy(null);
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
  });

  _testSetHealthy(true);
  const modeManager = await importFresh('./../src/domain/agents/index.js');
  modeManager.configureEnvForMode('plan');

  assert.equal(process.env.ANTHROPIC_API_KEY, undefined,
    'plan mode should clear API key (OAuth)');
  assert.equal(process.env.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/plan/anthropic`,
    'plan mode should encode mode in URL path: /m/plan/anthropic');
});

test('configureEnvForMode(api) falls back to direct when gateway unhealthy', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;

  t.onTestFinished(() => {
    _testSetHealthy(null);
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
  });

  _testSetHealthy(false);
  const modeManager = await importFresh('./../src/domain/agents/index.js');

  process.env.ANTHROPIC_API_KEY = 'sk-test-direct';
  process.env.ANTHROPIC_BASE_URL = 'https://saved.example.test';
  modeManager.configureEnvForMode('api');

  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test-direct',
    'api mode should restore API key when gateway unhealthy');
  assert.ok(!process.env.ANTHROPIC_BASE_URL?.includes('/m/'),
    'api mode should NOT use mode URL prefix when gateway unhealthy');
});

test('configureEnvForMode(plan) falls back to direct when gateway unhealthy', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  process.env.ANTHROPIC_API_KEY = 'sk-test-plan-direct';
  process.env.ANTHROPIC_BASE_URL = 'https://plan.example.test';

  t.onTestFinished(() => {
    _testSetHealthy(null);
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
  });

  _testSetHealthy(false);
  const modeManager = await importFresh('./../src/domain/agents/index.js');
  modeManager.configureEnvForMode('plan');

  assert.equal(process.env.ANTHROPIC_API_KEY, undefined,
    'plan mode should clear API key even when gateway unhealthy');
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined,
    'plan mode should remove base URL for direct OAuth when gateway unhealthy');
});

test('importing config.js does NOT mutate ANTHROPIC_API_KEY (no module side effect)', async (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  t.onTestFinished(() => {
    _testSetHealthy(null);
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
  });

  // CLI processes (cortex init / setup-gateway) import this module transitively and the
  // gateway is always unhealthy there. With mode=plan (isolated home → default), an
  // import-time configureEnvForMode would delete the key BEFORE discoverEndpoints runs,
  // making init unable to generate the api endpoint. Imports must be side-effect free.
  _testSetHealthy(null);
  process.env.ANTHROPIC_API_KEY = 'sk-import-probe';
  process.env.ANTHROPIC_BASE_URL = 'https://import-probe.example.test';

  await importFresh('./../src/domain/agents/config.js');

  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-import-probe',
    'importing config.js must not delete/rewrite ANTHROPIC_API_KEY');
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://import-probe.example.test',
    'importing config.js must not delete/rewrite ANTHROPIC_BASE_URL');
});

test('GATEWAY_ANTHROPIC_URL has /anthropic suffix (backward compat)', async (t) => {
  const modeManager = await importFresh('./../src/domain/agents/index.js');
  assert.ok(modeManager.GATEWAY_ANTHROPIC_URL.endsWith('/anthropic'),
    'gateway URL should end with /anthropic endpoint');
  assert.ok(modeManager.GATEWAY_ANTHROPIC_URL.startsWith('http://127.0.0.1:'),
    'gateway URL should be localhost');
});

test('gatewayModeUrl builds per-request mode URL', async (t) => {
  const modeManager = await importFresh('./../src/domain/agents/index.js');
  const planUrl = modeManager.gatewayModeUrl('plan');
  const apiUrl = modeManager.gatewayModeUrl('api');

  assert.ok(planUrl.includes('/m/plan/anthropic'), 'plan URL should contain /m/plan/anthropic');
  assert.ok(apiUrl.includes('/m/api/anthropic'), 'api URL should contain /m/api/anthropic');
  assert.notEqual(planUrl, apiUrl, 'plan and api URLs should differ');
  assert.ok(planUrl.startsWith('http://127.0.0.1:'), 'should be localhost');
});
