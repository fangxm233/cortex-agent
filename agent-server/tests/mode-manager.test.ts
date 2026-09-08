// input:  Vitest, fresh config, isolated dotenv, gateway mock
// output: mode routing, saved-key, and fallback tests
// pos:    Verify mode-manager routing and credential policy
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR } from '../src/core/paths.js';
import { importFresh } from './module-loader.js';

// Standard import (no cache buster) — same singleton instance that mode-manager uses
import { _testSetHealthy, GATEWAY_URL } from './../src/domain/costs/gateway-manager.js';

test('resolveModeEnv(api) encodes mode in URL when gateway healthy', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', true);

  process.env.ANTHROPIC_API_KEY = 'sk-test-late';
  process.env.ANTHROPIC_BASE_URL = 'https://late.example.test';
  const route = modeManager.resolveModeEnv('api');

  assert.equal(route.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/api/anthropic`,
    'api mode should encode mode in URL path: /m/api/anthropic');
  assert.equal(route.ANTHROPIC_API_KEY, 'sk-test-late',
    'api mode should KEEP the API key so Claude Code passes its startup credential check — upstream auth is handled by the gateway');
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://late.example.test',
    'the route belongs to one spawn — the daemon env keeps the credentials it already had');
});

test('resolveModeEnv(api) sets placeholder key when no key available and gateway healthy', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', true);

  const route = modeManager.resolveModeEnv('api');

  assert.equal(typeof modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER, 'string',
    'GATEWAY_MANAGED_KEY_PLACEHOLDER must be exported');
  assert.ok(modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER.length > 0, 'placeholder must be non-empty');
  assert.equal(route.ANTHROPIC_API_KEY, modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER,
    'with no saved key, a placeholder must be set so Claude Code can start on machines without OAuth login');
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined,
    'the placeholder is a per-spawn value: the aistatus gateway child inherits this env and resolves keys: [$ANTHROPIC_API_KEY] from it, so a placeholder here would be forwarded upstream as a credential');
});

test('resolveModeEnv(non-plan custom mode) keeps API key when gateway healthy', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', true);

  process.env.ANTHROPIC_API_KEY = 'sk-test-custom';
  const route = modeManager.resolveModeEnv('qwen-ksu');

  assert.equal(route.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/qwen-ksu/anthropic`,
    'custom mode should encode mode in URL path');
  assert.equal(route.ANTHROPIC_API_KEY, 'sk-test-custom',
    'non-plan modes should keep the API key — only plan mode requires the OAuth bearer path');
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined,
    'resolving a custom mode leaves the daemon env exactly as it was');
});

test('placeholder key never leaks into the daemon env (gateway healthy → unhealthy)', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', true);

  // Healthy + no real key → the placeholder goes to the child and nowhere else
  const gatewayRoute = modeManager.resolveModeEnv('api');
  assert.equal(typeof modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER, 'string',
    'GATEWAY_MANAGED_KEY_PLACEHOLDER must be exported');
  assert.equal(gatewayRoute.ANTHROPIC_API_KEY, modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined,
    'the placeholder cannot be folded back in as a saved key, because it never reaches the daemon env');

  // Gateway goes down → direct fallback must NOT treat the placeholder as a real saved key
  _testSetHealthy(false);
  const directRoute = modeManager.resolveModeEnv('api');
  assert.notEqual(directRoute.ANTHROPIC_API_KEY, modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER,
    'direct fallback must not send the placeholder to api.anthropic.com');
  assert.equal(directRoute.ANTHROPIC_API_KEY, null,
    'no real key was ever available, so direct fallback should have no key');
});

test('getSavedApiEnv ignores a gateway placeholder persisted in dotenv', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY=cortex-gateway-managed\n', false);

  assert.equal(modeManager.getSavedApiEnv().ANTHROPIC_API_KEY, undefined);
});

test('a live gateway placeholder cannot replace a real key saved in dotenv', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-saved"\n', true);
  pinClaudeCredential(t, false);
  process.env.ANTHROPIC_API_KEY = 'cortex-gateway-managed';
  assert.equal(modeManager.resolveModeEnv('api').ANTHROPIC_API_KEY, 'sk-ant-fixture-saved');
  _testSetHealthy(false);
  assert.equal(modeManager.resolveModeEnv('api').ANTHROPIC_API_KEY, 'sk-ant-fixture-saved');

  modeManager.applyAuthEnv();
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-fixture-saved',
    'the daemon env is where the gateway child reads $ANTHROPIC_API_KEY: a stale placeholder there must be replaced by the real saved key');
});

function readOptionalFile(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

function restoreFile(file: string, contents: string | undefined): void {
  if (contents === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, contents);
}

test('resolveModeEnv(plan) encodes mode in URL when gateway healthy', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', true);
  process.env.ANTHROPIC_API_KEY = 'sk-test-plan';
  process.env.ANTHROPIC_BASE_URL = 'https://managed.example.test';
  const route = modeManager.resolveModeEnv('plan');

  assert.equal(route.ANTHROPIC_API_KEY, null,
    'plan mode should clear API key (OAuth)');
  assert.equal(route.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/plan/anthropic`,
    'plan mode should encode mode in URL path: /m/plan/anthropic');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test-plan',
    'plan mode clears the key for its own child only — the daemon keeps the saved credential the gateway child needs');
});

test('resolveModeEnv(api) falls back to direct when gateway unhealthy', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', false);

  process.env.ANTHROPIC_API_KEY = 'sk-test-direct';
  process.env.ANTHROPIC_BASE_URL = 'https://saved.example.test';
  const route = modeManager.resolveModeEnv('api');

  assert.equal(route.ANTHROPIC_API_KEY, 'sk-test-direct',
    'api mode should restore API key when gateway unhealthy');
  assert.ok(!route.ANTHROPIC_BASE_URL?.includes('/m/'),
    'api mode should NOT use mode URL prefix when gateway unhealthy');
});

test('resolveModeEnv(plan) falls back to direct when gateway unhealthy', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', false);
  process.env.ANTHROPIC_API_KEY = 'sk-test-plan-direct';
  process.env.ANTHROPIC_BASE_URL = 'https://plan.example.test';
  const route = modeManager.resolveModeEnv('plan');

  assert.equal(route.ANTHROPIC_API_KEY, null,
    'plan mode should clear API key even when gateway unhealthy');
  assert.equal(route.ANTHROPIC_BASE_URL, undefined,
    'plan mode should remove base URL for direct OAuth when gateway unhealthy');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test-plan-direct',
    'the daemon env is not part of any route');
});

test('importing config.js does NOT mutate ANTHROPIC_API_KEY (no module side effect)', async (t) => {
  await freshConfigWithSavedEnv(t, '', false);

  // CLI processes (cortex init / setup-gateway) import this module transitively and the
  // gateway is always unhealthy there. With mode=plan (isolated home → default), an
  // an import-time apply would delete the key BEFORE discoverEndpoints runs,
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
  const modeManager = await freshConfigWithSavedEnv(t, '', false);
  assert.ok(modeManager.GATEWAY_ANTHROPIC_URL.endsWith('/anthropic'),
    'gateway URL should end with /anthropic endpoint');
  assert.ok(modeManager.GATEWAY_ANTHROPIC_URL.startsWith('http://127.0.0.1:'),
    'gateway URL should be localhost');
});

test('gatewayModeUrl builds per-request mode URL', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', false);
  const planUrl = modeManager.gatewayModeUrl('plan');
  const apiUrl = modeManager.gatewayModeUrl('api');

  assert.ok(planUrl.includes('/m/plan/anthropic'), 'plan URL should contain /m/plan/anthropic');
  assert.ok(apiUrl.includes('/m/api/anthropic'), 'api URL should contain /m/api/anthropic');
  assert.notEqual(planUrl, apiUrl, 'plan and api URLs should differ');
  assert.ok(planUrl.startsWith('http://127.0.0.1:'), 'should be localhost');
});

// --- resolveModeEnv: the mode decision as a value, not a global write (plan §4.1) ---

const ROUTE_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT'];

function snapshotRouteEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ROUTE_ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreRouteEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// The saved-credential snapshot is captured when config.js is evaluated, so the dotenv
// fixture must land BEFORE the fresh import; process.env is cleared so the fixture is
// the only credential source (getSavedApiEnv prefers process.env over the file).
// Fresh-import the state owner, not the SDK-heavy barrel: its query does not reset config.
async function freshConfigWithSavedEnv(
  t: { onTestFinished: (fn: () => void) => void },
  dotenv: string,
  healthy: boolean,
) {
  const envFile = path.join(CONFIG_DIR, '.env');
  const originalFile = readOptionalFile(envFile);
  const originalEnv = snapshotRouteEnv();
  t.onTestFinished(() => {
    _testSetHealthy(null);
    restoreFile(envFile, originalFile);
    restoreRouteEnv(originalEnv);
  });
  for (const key of ROUTE_ENV_KEYS) delete process.env[key];
  fs.writeFileSync(envFile, dotenv);
  _testSetHealthy(healthy);
  return importFresh('./../src/domain/agents/config.js');
}

test('resolveModeEnv(plan) routes via gateway and marks the API key for deletion', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-plan"\n', true);

  const modeEnv = modeManager.resolveModeEnv('plan');

  assert.equal(modeEnv.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/plan/anthropic`);
  assert.equal(modeEnv.ANTHROPIC_API_KEY, null,
    'plan mode must report null (= delete the variable), not a value and not undefined');
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in modeEnv),
    'the gateway route says nothing about the OAuth token — absent key means leave it alone');
});

test('resolveModeEnv(api) keeps the saved key on the gateway route', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-api"\n', true);

  const modeEnv = modeManager.resolveModeEnv('api');

  assert.equal(modeEnv.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/api/anthropic`);
  assert.equal(modeEnv.ANTHROPIC_API_KEY, 'sk-ant-fixture-api',
    'non-plan modes keep the key so Claude Code passes its startup credential check');
});

test('resolveModeEnv(custom mode) uses the placeholder key and encodes metadata', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', true);

  const modeEnv = modeManager.resolveModeEnv('qwen-ksu', { project: 'cortex-self' });

  assert.equal(modeEnv.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/qwen-ksu/project=cortex-self/anthropic`,
    'metadata must be encoded into the per-request mode URL');
  assert.equal(modeEnv.ANTHROPIC_API_KEY, modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER,
    'with no saved key the gateway route still needs a placeholder to start Claude Code');
});

test('resolveModeEnv(plan) unsets both route variables when the gateway is down', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-plan"\n', false);

  const modeEnv = modeManager.resolveModeEnv('plan');

  assert.equal(modeEnv.ANTHROPIC_BASE_URL, undefined,
    'direct plan mode talks to api.anthropic.com over OAuth — no base URL at all');
  assert.equal(modeEnv.ANTHROPIC_API_KEY, null, 'direct plan mode must delete the API key');
});

test('resolveModeEnv(api) restores the saved credentials when the gateway is down', async (t) => {
  const dotenv = 'ANTHROPIC_API_KEY="sk-ant-fixture-direct"\n'
    + 'ANTHROPIC_BASE_URL="https://direct.example.test"\n'
    + 'CLAUDE_CODE_OAUTH_TOKEN="oat-fixture-direct"\n';
  const modeManager = await freshConfigWithSavedEnv(t, dotenv, false);

  const modeEnv = modeManager.resolveModeEnv('api');

  assert.equal(modeEnv.ANTHROPIC_API_KEY, 'sk-ant-fixture-direct');
  assert.equal(modeEnv.ANTHROPIC_BASE_URL, 'https://direct.example.test');
  assert.equal(modeEnv.CLAUDE_CODE_OAUTH_TOKEN, 'oat-fixture-direct',
    'the direct route also projects the saved OAuth token, exactly as the old inline apply did');
});

test('resolveModeEnv(api) never hands the gateway placeholder to the direct route', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, '', false);

  const modeEnv = modeManager.resolveModeEnv('api');

  assert.equal(modeEnv.ANTHROPIC_API_KEY, null,
    'no real key was ever saved, so the direct route must delete the key — not send a placeholder');
  assert.equal(modeEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(modeEnv.CLAUDE_CODE_OAUTH_TOKEN, null);
});

test('resolveModeEnv decides without touching process.env', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-pure"\n', true);
  process.env.ANTHROPIC_API_KEY = 'sk-probe-untouched';
  process.env.ANTHROPIC_BASE_URL = 'https://probe.example.test';

  for (const healthy of [true, false]) {
    _testSetHealthy(healthy);
    modeManager.resolveModeEnv('plan');
    modeManager.resolveModeEnv('api');
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-probe-untouched',
      `resolveModeEnv must not write global env (gateway healthy=${healthy})`);
    assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://probe.example.test',
      `resolveModeEnv must not write global env (gateway healthy=${healthy})`);
  }
});


// --- applyAuthEnv: the daemon env carries saved credentials, never a mode route (plan §4.6) ---

/** Pins the Claude-owned credential probe, which otherwise reads the developer's real
 *  ~/.claude/.credentials.json and makes the arbitration result depend on the machine. */
function pinClaudeCredential(
  t: { onTestFinished: (fn: () => void) => void },
  owned: boolean,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.CLAUDE_CONFIG_DIR = dir;
  if (!owned) return;
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } }),
    { mode: 0o600 },
  );
}

test('applyAuthEnv hands the daemon a real key, never the gateway placeholder', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-daemon"\n', true);
  pinClaudeCredential(t, false);

  modeManager.applyAuthEnv();

  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-fixture-daemon',
    'the aistatus gateway child inherits this env and resolves keys: [$ANTHROPIC_API_KEY] from it');
  assert.notEqual(process.env.ANTHROPIC_API_KEY, modeManager.GATEWAY_MANAGED_KEY_PLACEHOLDER);
});

test('applyAuthEnv deletes a placeholder rather than leaving it for the gateway child', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="cortex-gateway-managed"\n', true);
  pinClaudeCredential(t, false);
  process.env.ANTHROPIC_API_KEY = 'cortex-gateway-managed';

  modeManager.applyAuthEnv();

  assert.equal(process.env.ANTHROPIC_API_KEY, undefined,
    'a real key or nothing: the placeholder is not a credential and would be forwarded upstream as one');
});

test('applyAuthEnv keeps the mode route out of the daemon env', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-route"\n', true);
  pinClaudeCredential(t, false);
  process.env.ANTHROPIC_BASE_URL = 'https://untouched.example.test';

  const route = modeManager.resolveModeEnv('openai-codex');
  modeManager.applyAuthEnv();

  assert.equal(route.ANTHROPIC_BASE_URL, `${GATEWAY_URL}/m/openai-codex/anthropic`);
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://untouched.example.test',
    'a mode URL in the daemon env is what made the usage probe inherit a non-subscription route (K-053)');
});

test('applyAuthEnv projects the legacy .env token while Claude owns no credential', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'CLAUDE_CODE_OAUTH_TOKEN="oat-fixture-legacy"\n', false);
  pinClaudeCredential(t, false);

  modeManager.applyAuthEnv();

  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, 'oat-fixture-legacy',
    'without a Claude-owned credential the saved token is the only way a spawn can authenticate');
});

test('applyAuthEnv never revives the legacy .env token once Claude owns the credential', async (t) => {
  const dotenv = 'ANTHROPIC_API_KEY="sk-ant-fixture-arbitration"\n'
    + 'CLAUDE_CODE_OAUTH_TOKEN="oat-fixture-legacy"\n'
    + 'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT="1893456000000"\n';
  // Gateway down + a saved API key is exactly the combination whose direct-route projection
  // used to write the token back after the ownership check had deleted it.
  const modeManager = await freshConfigWithSavedEnv(t, dotenv, false);
  pinClaudeCredential(t, true);

  modeManager.applyAuthEnv();

  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined,
    'the arbitration: .credentials.json owns the account, so the static .env copy may not shadow the token claude login refreshes');
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT, undefined,
    'an expiry without its token is a stale claim about a credential that is not there');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-fixture-arbitration',
    'the arbitration covers the OAuth token only — the saved API key still reaches the daemon env');
});

test('switchMode flips the mode without touching the daemon env', async (t) => {
  const modeManager = await freshConfigWithSavedEnv(t, 'ANTHROPIC_API_KEY="sk-ant-fixture-switch"\n', true);
  pinClaudeCredential(t, false);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-switch';
  process.env.ANTHROPIC_BASE_URL = 'https://switch.example.test';

  const { oldMode, newMode } = modeManager.switchMode();

  assert.notEqual(oldMode, newMode, 'switchMode must still flip the persisted mode');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-fixture-switch');
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://switch.example.test',
    'switching modes is a routing decision — it may not repoint the daemon or anything that inherits its env');
});
