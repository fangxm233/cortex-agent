import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, vi } from 'vitest';
import { EventBus } from '../../src/events/event-bus.js';
import { CONNECTIONS_FILE, claudeKeyConnections, readConnections } from '../../src/core/connections-file.js';
import {
  initAuthEvents,
  publishAuthRequired,
} from '../../src/domain/auth/auth-events.js';
import {
  getFlowState,
  respondPrompt,
  startFlow,
  type AuthInteraction,
  type LoginFlowConsumer,
  type LoginFlowStep,
} from '../../src/domain/auth/login-flow.js';

const OLD_KEY = 'sk-ant-fixture-old';
const NEW_KEY = 'sk-ant-fixture-new';

type GetAuthStatus = typeof import('../../src/domain/auth/auth-status.js')['getAuthStatus'];

interface AuthFixture {
  envFile: string;
  initialEnv: string;
}

/** The `api` connection's key as config/connections.json holds it. */
function storedApiKey(): string | undefined {
  return claudeKeyConnections(readConnections()).find(entry => entry.id === 'api')?.key;
}

interface CleanupContext {
  onTestFinished(callback: () => void): void;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setupAuthFixture(t: CleanupContext): AuthFixture {
  const home = process.env.CORTEX_HOME!;
  const claudeDir = fs.mkdtempSync(path.join(home, 'claude-login-'));
  const credentialEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT'];
  const originals = new Map(['HOME', 'CLAUDE_CONFIG_DIR', ...credentialEnv]
    .map(name => [name, process.env[name]]));
  t.onTestFinished(() => {
    for (const [name, value] of originals) restoreEnv(name, value);
    initAuthEvents(null);
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(CONNECTIONS_FILE, { force: true });
  });
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  for (const name of credentialEnv) delete process.env[name];
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'mode.json'), JSON.stringify({ claudeMode: 'plan' }));
  const envFile = path.join(home, 'config', '.env');
  const initialEnv = 'OTHER_SETTING=keep\n';
  fs.writeFileSync(envFile, initialEnv, { mode: 0o644 });
  return { envFile, initialEnv };
}

function captureConsole(t: CleanupContext): unknown[][] {
  const calls: unknown[][] = [];
  for (const method of ['debug', 'log', 'info', 'warn', 'error'] as const) {
    const spy = vi.spyOn(console, method).mockImplementation((...args) => { calls.push(args); });
    t.onTestFinished(() => spy.mockRestore());
  }
  return calls;
}

function captureRecovery(): Array<{ type: string; backend: string; provider: string }> {
  const bus = new EventBus();
  const recovered: Array<{ type: string; backend: string; provider: string }> = [];
  bus.subscribe('auth.recovered', event => { recovered.push(event); });
  initAuthEvents(bus);
  publishAuthRequired({
    backend: 'claude', provider: 'anthropic', authType: 'api_key', kind: 'invalid_api_key',
    channel: 'web:fixture', sessionId: 'fixture-session',
  });
  return recovered;
}

async function waitForStep(flowId: string, expected: LoginFlowStep): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getFlowState(flowId)?.step === expected) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`flow ${flowId} did not reach ${expected}`);
}

async function runLogin(login: LoginFlowConsumer, key: string) {
  let outcome: unknown;
  const flow = await startFlow({
    backend: 'claude', provider: 'anthropic', authType: 'api_key',
    channel: 'web:fixture', sessionId: 'fixture-session',
  }, async interaction => {
    const result = await login(interaction);
    outcome = result;
    return result;
  });
  await waitForStep(flow.flowId, 'prompt');
  const response = respondPrompt(flow.flowId, key);
  await waitForStep(flow.flowId, 'done');
  return { outcome, response, state: getFlowState(flow.flowId) };
}

async function readClaudeStatus(getAuthStatus: GetAuthStatus) {
  const snapshot = await getAuthStatus({
    getDefaultClaudeConnection: () => 'api', getActiveBackend: () => 'claude', listFavorites: () => [],
    loadPiRuntime: async () => ({
      available: false, version: null, entry: null, error: 'fixture runtime unavailable',
      runtime: null, readStoredCredential: null,
    }),
  });
  return snapshot.accounts.find(account => account.backend === 'claude')!;
}

interface LoginEvidence {
  fixture: AuthFixture;
  result: Awaited<ReturnType<typeof runLogin>>;
  account: Awaited<ReturnType<typeof readClaudeStatus>>;
  persisted: string;
  savedKey: string | undefined;
  recovered: Array<{ type: string; backend: string; provider: string }>;
  consoleCalls: unknown[][];
}

function assertSuccessfulLogin(evidence: LoginEvidence): void {
  const expectedOutcome = { provider: 'anthropic', authType: 'api_key', expiresAt: null };
  assert.deepEqual(evidence.result.outcome, expectedOutcome);
  assert.deepEqual(evidence.result.state?.outcome, expectedOutcome);
  assert.equal(evidence.account.authType, 'api_key');
  assert.equal(evidence.account.state, 'logged-in');
  assert.equal(evidence.savedKey, NEW_KEY);
  // The key lives on the `api` connection, owner-only; each spawn takes it from there, so a login
  // never projects it into the daemon env, and config/.env is left to its other settings.
  assert.equal(storedApiKey(), NEW_KEY);
  assert.equal(fs.statSync(CONNECTIONS_FILE).mode & 0o777, 0o600);
  assert.notEqual(process.env.ANTHROPIC_API_KEY, NEW_KEY);
  assert.equal(evidence.persisted, evidence.fixture.initialEnv);
  assert.deepEqual(evidence.recovered.map(({ type, backend, provider }) => ({ type, backend, provider })), [
    { type: 'auth.recovered', backend: 'claude', provider: 'anthropic' },
  ]);
  const observable = [evidence.result, evidence.recovered, evidence.consoleCalls];
  assert.equal(JSON.stringify(observable).includes(NEW_KEY), false);
}

test('Claude API-key LoginFlow persists securely, reloads runtime, recovers auth, and updates status', async (t) => {
  const fixture = setupAuthFixture(t);
  const consoleCalls = captureConsole(t);
  const { loginClaudeApiKey } = await import('../../src/domain/auth/cc-login.js');
  const { getAuthStatus } = await import('../../src/domain/auth/auth-status.js');
  assert.equal((await readClaudeStatus(getAuthStatus)).state, 'logged-out');
  const recovered = captureRecovery();
  const result = await runLogin(loginClaudeApiKey, NEW_KEY);
  const account = await readClaudeStatus(getAuthStatus);
  const persisted = fs.readFileSync(fixture.envFile, 'utf8');
  assertSuccessfulLogin({
    fixture, result, account, persisted,
    savedKey: storedApiKey(), recovered, consoleCalls,
  });
});

test('a Claude key save beside a concurrent Feishu dotenv write keeps both, with the key off .env', async (t) => {
  const fixture = setupAuthFixture(t);
  const { saveAnthropicApiKey } = await import('../../src/domain/auth/anthropic-env.js');
  const { upsertEnvVar } = await import('../../src/entry/feishu-login.js');

  const claudeWrite = saveAnthropicApiKey(NEW_KEY);
  await upsertEnvVar(fixture.envFile, 'FEISHU_AUTH_MODE', 'user');
  await claudeWrite;

  const persisted = fs.readFileSync(fixture.envFile, 'utf8');
  assert.doesNotMatch(persisted, /ANTHROPIC_API_KEY/);
  assert.match(persisted, /^FEISHU_AUTH_MODE=user$/m);
  assert.equal(storedApiKey(), NEW_KEY);
});

test('saving a key over an existing api connection keeps its endpoint and auth style', async (t) => {
  setupAuthFixture(t);
  const { upsertConnection } = await import('../../src/core/connections-file.js');
  const { saveAnthropicApiKey } = await import('../../src/domain/auth/anthropic-env.js');
  upsertConnection({
    id: 'api', backend: 'claude', label: 'Relay', baseUrl: 'https://relay.example.invalid',
    authStyle: 'bearer', key: OLD_KEY, billing: 'metered',
  });
  await saveAnthropicApiKey(NEW_KEY);
  assert.deepEqual(readConnections(), [{
    id: 'api', backend: 'claude', label: 'Relay', baseUrl: 'https://relay.example.invalid',
    authStyle: 'bearer', key: NEW_KEY, billing: 'metered',
  }]);
});

test('Claude API-key login rejects a malformed key without side effects', async (t) => {
  const fixture = setupAuthFixture(t);
  const { loginClaudeApiKey } = await import('../../src/domain/auth/cc-login.js');
  const recovered = captureRecovery();
  const interaction: AuthInteraction = {
    prompt: async () => 'sk-ant-fixture "malformed"',
    notify: () => {},
  };
  await assert.rejects(loginClaudeApiKey(interaction), (error: any) => (
    error?.code === 'claude_api_key_save_failed'
    && error.message === 'Could not save the Anthropic API key: Enter a valid Anthropic API key.'
  ));
  assert.equal(fs.readFileSync(fixture.envFile, 'utf8'), fixture.initialEnv);
  assert.equal(fs.existsSync(CONNECTIONS_FILE), false);
  assert.deepEqual(recovered, []);
});
