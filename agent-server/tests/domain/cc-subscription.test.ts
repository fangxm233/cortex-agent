// input:  Claude subscription consumer, LoginFlow, fake tmux, saved env
// output: tmux interaction, cleanup, persistence, and privacy regressions
// pos:    Claude subscription login regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { NewSessionOptions } from '../../src/agent-adapter/claude/tmux-control.js';
import { CONFIG_DIR } from '../../src/core/utils.js';
import { _testSetHealthy } from '../../src/domain/costs/gateway-manager.js';
import {
  getFlowState,
  LOGIN_FLOW_TTL_MS,
  respondPrompt,
  startFlow,
  type AuthInteraction,
  type LoginFlowState,
  type LoginFlowStep,
} from '../../src/domain/auth/login-flow.js';
import {
  loginClaudeSubscription,
  type ClaudeSubscriptionLoginDependencies,
} from '../../src/domain/auth/cc-subscription.js';
import {
  configureEnvForMode,
  getSavedApiEnv,
  saveClaudeCodeOAuthToken,
} from '../../src/domain/agents/config.js';

const REAL_HOME = process.env.HOME!;
const TOKEN = 'sk-ant-oat01-fixture-private-token';
const CODE = 'fixture-code#fixture-state';
const AUTH_URL = 'https://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&state=fixture';
const INITIAL_PANE = `Browser didn't open? Use the url below to sign in (c to copy)\n\nhttps://claude.com/cai/oauth/authorize?code=true&scope=user%3\nAinference&state=fixture\n\nPaste code here if prompted >`;
const SUCCESS_PANE = `Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n${TOKEN}\n\nStore this token securely.`;

class FakeTmux {
  readonly sessions = new Set<string>();
  readonly starts: NewSessionOptions[] = [];
  readonly pasted: string[] = [];
  readonly keys: string[][] = [];
  readonly kills: string[] = [];
  submitted = false;
  dieOnStart = false;
  exitCliOnSubmit = false;

  constructor(
    private readonly initialPane = INITIAL_PANE,
    private readonly finalPane = SUCCESS_PANE,
  ) {}

  newSession(options: NewSessionOptions): void {
    this.starts.push(options);
    this.sessions.add(options.name);
    if (this.dieOnStart) this.sessions.delete(options.name);
  }

  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }

  capturePane(name: string): string {
    assert.equal(this.sessions.has(name), true);
    return this.submitted ? this.finalPane : this.initialPane;
  }

  pasteText(_name: string, value: string): void {
    this.pasted.push(value);
  }

  sendKeys(_name: string, ...keys: string[]): void {
    this.keys.push(keys);
    if (!keys.includes('Enter')) return;
    this.submitted = true;
    const command = this.starts[0]?.command ?? [];
    const holdsPane = command[0] === 'bash' && command.some(value => value.includes('while :'));
    if (this.exitCliOnSubmit && !holdsPane) this.sessions.clear();
  }

  killSession(name: string): void {
    this.kills.push(name);
    this.sessions.delete(name);
  }
}

interface CleanupContext {
  onTestFinished(callback: () => void): void;
}

interface SuccessEvidence {
  tmux: FakeTmux;
  saved: string[];
  recovered: Array<{ backend: 'claude'; provider: string }>;
  reloads: number;
  dependencies: ClaudeSubscriptionLoginDependencies;
}

function successDependencies(tmux = new FakeTmux()): SuccessEvidence {
  const saved: string[] = [];
  const recovered: Array<{ backend: 'claude'; provider: string }> = [];
  let reloads = 0;
  return {
    tmux, saved, recovered,
    get reloads() { return reloads; },
    dependencies: {
      tmux,
      cwd: process.env.CORTEX_HOME!,
      sessionName: () => 'cortex-claude-auth-fixture',
      saveToken: async token => { saved.push(token); },
      reloadAuth: () => { reloads += 1; },
      publishRecovered: input => { recovered.push(input); },
      submitDelayMs: 0,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    },
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

async function waitForStep(flowId: string, expected: LoginFlowStep): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getFlowState(flowId)?.step === expected) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail(`flow ${flowId} did not reach ${expected}`);
}

function flowInput() {
  return {
    backend: 'claude' as const,
    provider: 'anthropic',
    authType: 'oauth' as const,
    channel: 'web:fixture',
    sessionId: 'fixture-session',
  };
}

function inertInteraction(signal?: AbortSignal): AuthInteraction {
  return {
    signal,
    prompt: async () => new Promise<string>(() => {}),
    notify: () => {},
  };
}

function assertSafeError(code: string) {
  return (error: any) => {
    assert.equal(error?.name, 'LoginFlowError');
    assert.equal(error?.code, code);
    assert.equal(String(error?.message).includes(TOKEN), false);
    return true;
  };
}

function captureConsole(t: CleanupContext): unknown[][] {
  const calls: unknown[][] = [];
  for (const method of ['debug', 'log', 'info', 'warn', 'error'] as const) {
    const spy = vi.spyOn(console, method).mockImplementation((...args) => { calls.push(args); });
    t.onTestFinished(() => spy.mockRestore());
  }
  return calls;
}

function assertTmuxSuccess(tmux: FakeTmux): void {
  assert.deepEqual(tmux.pasted, [CODE]);
  assert.deepEqual(tmux.keys, [['Enter']]);
  const start = tmux.starts[0];
  assert.equal(start.command[0], 'bash');
  assert.equal(start.command.includes('claude'), true);
  assert.match(start.command.join(' '), /setup-token/);
  assert.deepEqual(start.env, {
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '',
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
    CCR_OAUTH_TOKEN_FILE: '',
  });
  assert.equal(tmux.sessions.size, 0);
  assert.equal(tmux.kills.length, 1);
}

function assertSuccessfulFlow(
  evidence: SuccessEvidence,
  waiting: LoginFlowState,
  completed: LoginFlowState,
  consoleCalls: unknown[][],
): void {
  assert.deepEqual(completed.outcome, {
    provider: 'anthropic', authType: 'oauth', expiresAt: null,
  });
  assert.deepEqual(completed.notice, {
    kind: 'progress', message: 'Completing Claude subscription login.',
  });
  assert.deepEqual(evidence.saved, [TOKEN]);
  assert.equal(evidence.reloads, 1);
  assert.deepEqual(evidence.recovered, [{ backend: 'claude', provider: 'anthropic' }]);
  assertTmuxSuccess(evidence.tmux);
  const observable = [waiting, completed, evidence.recovered, consoleCalls, evidence.tmux.starts];
  assert.equal(JSON.stringify(observable).includes(TOKEN), false);
  assert.equal(JSON.stringify(observable).includes(CODE), false);
}

beforeEach(() => {
  process.env.HOME = process.env.CORTEX_HOME!;
  fs.mkdirSync(path.join(process.env.HOME, '.claude'), { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  _testSetHealthy(null);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.HOME = REAL_HOME;
});

test('Claude subscription LoginFlow forwards URL and code, persists privately, recovers, and cleans up', async (t) => {
  const evidence = successDependencies();
  evidence.tmux.exitCliOnSubmit = true;
  const consoleCalls = captureConsole(t);
  const flow = await startFlow(flowInput(), interaction =>
    loginClaudeSubscription(interaction, evidence.dependencies));
  await waitForStep(flow.flowId, 'prompt');

  const waiting = getFlowState(flow.flowId)!;
  assert.deepEqual(waiting.pendingPrompt, {
    kind: 'manual_code', message: 'Paste code here if prompted.',
  });
  assert.deepEqual(waiting.notice, {
    kind: 'auth_url', url: AUTH_URL, instructions: undefined,
  });
  await respondPrompt(flow.flowId, CODE);
  await waitForStep(flow.flowId, 'done');
  assertSuccessfulFlow(evidence, waiting, getFlowState(flow.flowId)!, consoleCalls);
});

test('Claude subscription CLI failure is safely classified and kills its tmux session', async () => {
  const tmux = new FakeTmux('OAuth error: Invalid code. Please make sure the full code was copied');
  const evidence = successDependencies(tmux);

  await assert.rejects(
    loginClaudeSubscription(inertInteraction(), evidence.dependencies),
    assertSafeError('claude_subscription_failed'),
  );
  assert.equal(tmux.sessions.size, 0);
  assert.equal(tmux.kills.length, 1);
  assert.deepEqual(evidence.saved, []);
  assert.deepEqual(evidence.recovered, []);
});

test('Claude subscription detects an exited tmux process and leaves no orphan', async () => {
  const tmux = new FakeTmux();
  tmux.dieOnStart = true;
  const evidence = successDependencies(tmux);

  await assert.rejects(
    loginClaudeSubscription(inertInteraction(), evidence.dependencies),
    assertSafeError('claude_subscription_failed'),
  );
  assert.equal(tmux.sessions.size, 0);
  assert.equal(tmux.kills.length, 1);
});

test('flow-wide cancellation interrupts a pending CLI question and kills tmux', async () => {
  const tmux = new FakeTmux();
  const evidence = successDependencies(tmux);
  const controller = new AbortController();
  const login = loginClaudeSubscription(inertInteraction(controller.signal), evidence.dependencies);
  const rejected = assert.rejects(login, assertSafeError('claude_subscription_cancelled'));
  await flush();

  controller.abort();
  await rejected;
  assert.equal(tmux.sessions.size, 0);
  assert.equal(tmux.kills.length, 1);
});

test('consumer timeout kills the tmux session without persisting credentials', async () => {
  vi.useFakeTimers();
  const tmux = new FakeTmux('Waiting for OAuth setup...');
  const evidence = successDependencies(tmux);
  evidence.dependencies.timeoutMs = 25;
  evidence.dependencies.pollIntervalMs = 5;
  const login = loginClaudeSubscription(inertInteraction(), evidence.dependencies);
  const rejected = assert.rejects(login, assertSafeError('claude_subscription_timeout'));

  await vi.advanceTimersByTimeAsync(30);
  await rejected;
  assert.equal(tmux.sessions.size, 0);
  assert.equal(tmux.kills.length, 1);
  assert.deepEqual(evidence.saved, []);
});

test('LoginFlow TTL abort kills a subscription tmux session with no pending process', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  const tmux = new FakeTmux();
  const evidence = successDependencies(tmux);
  evidence.dependencies.timeoutMs = LOGIN_FLOW_TTL_MS * 2;
  const flow = await startFlow(flowInput(), interaction =>
    loginClaudeSubscription(interaction, evidence.dependencies));
  await flush();
  assert.equal(getFlowState(flow.flowId)?.step, 'prompt');

  await vi.advanceTimersByTimeAsync(LOGIN_FLOW_TTL_MS);
  await flush();
  assert.equal(getFlowState(flow.flowId), null);
  assert.equal(tmux.sessions.size, 0);
  assert.equal(tmux.kills.length, 1);
  assert.deepEqual(evidence.saved, []);
});

test('saved Claude OAuth token uses atomic dotenv persistence, mode 0600, and plan reload', async () => {
  const envFile = path.join(CONFIG_DIR, '.env');
  const liveCredentials = path.join(REAL_HOME, '.claude', '.credentials.json');
  const before = fs.existsSync(liveCredentials) ? fs.statSync(liveCredentials) : null;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(envFile, 'OTHER_SETTING=keep\nANTHROPIC_API_KEY="fixture-key"\n', { mode: 0o644 });
  _testSetHealthy(false);

  await saveClaudeCodeOAuthToken(TOKEN);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  configureEnvForMode('plan');

  const persisted = fs.readFileSync(envFile, 'utf8');
  assert.match(persisted, /^OTHER_SETTING=keep$/m);
  assert.match(persisted, /^ANTHROPIC_API_KEY="fixture-key"$/m);
  assert.match(persisted, /^CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-fixture-private-token"$/m);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.equal(getSavedApiEnv().CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  const after = fs.existsSync(liveCredentials) ? fs.statSync(liveCredentials) : null;
  assert.deepEqual(
    after && { ino: after.ino, size: after.size, mtimeMs: after.mtimeMs },
    before && { ino: before.ino, size: before.size, mtimeMs: before.mtimeMs },
  );
});
