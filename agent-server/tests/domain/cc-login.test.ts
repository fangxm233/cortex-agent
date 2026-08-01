// input:  Claude/Feishu env writers, LoginFlow, temporary config
// output: API-key persistence, concurrency, recovery, privacy tests
// pos:    Claude API-key login regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, vi } from 'vitest';
import { EventBus } from '../../src/events/event-bus.js';
import { _testSetHealthy } from '../../src/domain/costs/gateway-manager.js';
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

const PLACEHOLDER = 'cortex-gateway-managed';
const OLD_KEY = 'sk-ant-fixture-old';
const NEW_KEY = 'sk-ant-fixture-new';

type GetAuthStatus = typeof import('../../src/domain/auth/auth-status.js')['getAuthStatus'];

interface AuthFixture {
  envFile: string;
  initialEnv: string;
}

interface CleanupContext {
  onTestFinished(callback: () => void): void;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setupAuthFixture(t: CleanupContext, initialKey: string = PLACEHOLDER): AuthFixture {
  const home = process.env.CORTEX_HOME!;
  const originals = new Map(['HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']
    .map(name => [name, process.env[name]]));
  t.onTestFinished(() => {
    for (const [name, value] of originals) restoreEnv(name, value);
    _testSetHealthy(null);
    initAuthEvents(null);
  });
  process.env.HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'mode.json'), JSON.stringify({ claudeMode: 'plan' }));
  const envFile = path.join(home, 'config', '.env');
  const initialEnv = `OTHER_SETTING=keep\nANTHROPIC_API_KEY=${initialKey}\n`;
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
    getClaudeMode: () => 'api', getActiveBackend: () => 'claude', listProfiles: () => [],
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
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(evidence.persisted.includes('OTHER_SETTING=keep'), true);
  assert.equal(evidence.persisted.includes(NEW_KEY), true);
  assert.equal(evidence.persisted.includes(PLACEHOLDER), false);
  assert.equal(fs.statSync(evidence.fixture.envFile).mode & 0o777, 0o600);
  assert.deepEqual(evidence.recovered.map(({ type, backend, provider }) => ({ type, backend, provider })), [
    { type: 'auth.recovered', backend: 'claude', provider: 'anthropic' },
  ]);
  const observable = [evidence.result, evidence.recovered, evidence.consoleCalls];
  assert.equal(JSON.stringify(observable).includes(NEW_KEY), false);
}

test('Claude API-key LoginFlow persists securely, reloads runtime, recovers auth, and updates status', async (t) => {
  const fixture = setupAuthFixture(t);
  const consoleCalls = captureConsole(t);
  _testSetHealthy(false);
  const { loginClaudeApiKey } = await import('../../src/domain/auth/cc-login.js');
  const { getAuthStatus } = await import('../../src/domain/auth/auth-status.js');
  const config = await import('../../src/domain/agents/config.js');
  assert.equal((await readClaudeStatus(getAuthStatus)).state, 'logged-out');
  process.env.ANTHROPIC_API_KEY = OLD_KEY;
  const recovered = captureRecovery();
  const result = await runLogin(loginClaudeApiKey, NEW_KEY);
  const account = await readClaudeStatus(getAuthStatus);
  const persisted = fs.readFileSync(fixture.envFile, 'utf8');
  assertSuccessfulLogin({
    fixture, result, account, persisted,
    savedKey: config.getSavedApiEnv().ANTHROPIC_API_KEY, recovered, consoleCalls,
  });
});

test('Claude and Feishu dotenv writes preserve both concurrent updates', async (t) => {
  const fixture = setupAuthFixture(t);
  const { saveAnthropicApiKey } = await import('../../src/domain/agents/config.js');
  const { upsertEnvVar } = await import('../../src/entry/feishu-login.js');

  const claudeWrite = saveAnthropicApiKey(NEW_KEY);
  await upsertEnvVar(fixture.envFile, 'FEISHU_AUTH_MODE', 'user');
  await claudeWrite;

  const persisted = fs.readFileSync(fixture.envFile, 'utf8');
  assert.match(persisted, /^ANTHROPIC_API_KEY="sk-ant-fixture-new"$/m);
  assert.match(persisted, /^FEISHU_AUTH_MODE=user$/m);
});

test('Claude API-key login rejects the gateway placeholder without side effects', async (t) => {
  const fixture = setupAuthFixture(t, OLD_KEY);
  _testSetHealthy(false);
  const { loginClaudeApiKey } = await import('../../src/domain/auth/cc-login.js');
  const recovered = captureRecovery();
  const interaction: AuthInteraction = {
    prompt: async () => PLACEHOLDER,
    notify: () => {},
  };
  await assert.rejects(loginClaudeApiKey(interaction), /valid Anthropic API key/i);
  assert.equal(fs.readFileSync(fixture.envFile, 'utf8'), fixture.initialEnv);
  assert.deepEqual(recovered, []);
});
