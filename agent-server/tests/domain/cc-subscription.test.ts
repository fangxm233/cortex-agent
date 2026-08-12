// input:  Claude subscription bridge, LoginFlow, fake auth CLI
// output: URL/code relay, cleanup, recovery, and safe failure tests
// pos:    Claude subscription LoginFlow bridge tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  getFlowState,
  respondPrompt,
  startFlow,
  type LoginFlowState,
  type LoginFlowStep,
} from '../../src/domain/auth/login-flow.js';
import {
  ClaudeAuthCliError,
  type ClaudeAuthLoginOptions,
  type ClaudeAuthStatus,
} from '../../src/domain/auth/cc-auth-cli.js';
import {
  loginClaudeSubscription,
  type ClaudeSubscriptionLoginDependencies,
} from '../../src/domain/auth/cc-subscription.js';
import { initAuthEvents } from '../../src/domain/auth/auth-events.js';
import {
  configureEnvForMode,
  removeClaudeCodeOAuthToken,
  saveClaudeCodeOAuthToken,
} from '../../src/domain/agents/config.js';
import { _testSetHealthy } from '../../src/domain/costs/gateway-manager.js';

const AUTH_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=fixture';
const CODE = 'fixture-code#fixture-state';
const STATUS: ClaudeAuthStatus = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
};

function flowInput() {
  return {
    backend: 'claude' as const,
    provider: 'anthropic',
    authType: 'oauth' as const,
    channel: 'web:fixture',
    sessionId: 'fixture-session',
  };
}

async function waitForStep(flowId: string, expected: LoginFlowStep): Promise<LoginFlowState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = getFlowState(flowId);
    if (state?.step === expected) return state;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail(`flow ${flowId} did not reach ${expected}`);
}

interface SuccessEvidence {
  codes: string[];
  cleanup: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  recovered: Array<{ backend: 'claude'; provider: string }>;
  dependencies: ClaudeSubscriptionLoginDependencies;
}

function successEvidence(): SuccessEvidence {
  const codes: string[] = [];
  const cleanup = vi.fn(async () => {});
  const reload = vi.fn();
  const recovered: Array<{ backend: 'claude'; provider: string }> = [];
  return {
    codes, cleanup, reload, recovered,
    dependencies: {
      login: async (options: ClaudeAuthLoginOptions) => {
        codes.push(await options.onAuthorization(AUTH_URL));
        options.onCodeSubmitted?.();
        return STATUS;
      },
      removeLegacyToken: cleanup,
      reloadAuth: reload,
      publishRecovered: input => { recovered.push(input); },
    },
  };
}

function safeFailure(code: string, secret = CODE) {
  return (error: any) => error?.name === 'LoginFlowError'
    && error?.code === code
    && !String(error?.message).includes(secret);
}

afterEach(async () => {
  initAuthEvents(null);
  _testSetHealthy(null);
  await removeClaudeCodeOAuthToken();
});

test('subscription relays URL/code to claude auth login and completes only after legacy cleanup', async () => {
  const evidence = successEvidence();
  const flow = await startFlow(flowInput(), interaction => (
    loginClaudeSubscription(interaction, evidence.dependencies)
  ));
  const waiting = await waitForStep(flow.flowId, 'prompt');

  assert.deepEqual(waiting.notice, {
    kind: 'auth_url', url: AUTH_URL, instructions: undefined,
  });
  assert.deepEqual(waiting.pendingPrompt, {
    kind: 'manual_code', message: 'Paste code here if prompted.',
  });
  await respondPrompt(flow.flowId, CODE);
  const completed = await waitForStep(flow.flowId, 'done');

  assert.deepEqual(completed.outcome, {
    provider: 'anthropic', authType: 'oauth', expiresAt: null,
    detail: 'Credential managed by Claude Code.',
  });
  assert.deepEqual(completed.notice, {
    kind: 'progress', message: 'Completing Claude subscription login.',
  });
  assert.deepEqual(evidence.codes, [CODE]);
  assert.equal(evidence.cleanup.mock.calls.length, 1);
  assert.equal(evidence.reload.mock.calls.length, 1);
  assert.deepEqual(evidence.recovered, [{ backend: 'claude', provider: 'anthropic' }]);
  assert.equal(JSON.stringify([waiting, completed, evidence.recovered]).includes(CODE), false);
});

test('subscription does not publish recovery when legacy token cleanup fails', async () => {
  const evidence = successEvidence();
  evidence.dependencies.removeLegacyToken = async () => { throw new Error('fixture cleanup'); };

  await assert.rejects(
    loginClaudeSubscription({
      prompt: async () => CODE,
      notify: () => {},
    }, evidence.dependencies),
    safeFailure('claude_subscription_cleanup_failed'),
  );

  assert.equal(evidence.reload.mock.calls.length, 0);
  assert.deepEqual(evidence.recovered, []);
});

test('subscription maps CLI cancellation and timeout to stable LoginFlow errors', async () => {
  for (const [cliCode, flowCode] of [
    ['claude_auth_cancelled', 'claude_subscription_cancelled'],
    ['claude_auth_timeout', 'claude_subscription_timeout'],
  ] as const) {
    const evidence = successEvidence();
    evidence.dependencies.login = async () => {
      throw new ClaudeAuthCliError(cliCode, `unsafe-${CODE}`);
    };
    await assert.rejects(
      loginClaudeSubscription({ prompt: async () => CODE, notify: () => {} }, evidence.dependencies),
      safeFailure(flowCode),
    );
    assert.equal(evidence.cleanup.mock.calls.length, 0);
    assert.deepEqual(evidence.recovered, []);
  }
});

test('plan mode admits a legacy token only until Claude owns a credential', async (t) => {
  const previousHome = process.env.HOME;
  const home = process.env.CORTEX_HOME!;
  const credentialsPath = path.join(home, '.claude', '.credentials.json');
  t.onTestFinished(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  process.env.HOME = home;
  fs.rmSync(path.dirname(credentialsPath), { recursive: true, force: true });
  await saveClaudeCodeOAuthToken('sk-ant-oat01-legacy-fixture');
  _testSetHealthy(false);

  configureEnvForMode('plan');
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-legacy-fixture');

  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: {
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
  } }), { mode: 0o600 });
  configureEnvForMode('plan');
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('subscription maps unsuccessful CLI postconditions without leaking command output', async () => {
  const evidence = successEvidence();
  evidence.dependencies.login = async () => {
    throw new ClaudeAuthCliError('claude_auth_not_logged_in', `unsafe-${CODE}`);
  };

  await assert.rejects(
    loginClaudeSubscription({ prompt: async () => CODE, notify: () => {} }, evidence.dependencies),
    safeFailure('claude_subscription_failed'),
  );

  assert.equal(evidence.cleanup.mock.calls.length, 0);
  assert.deepEqual(evidence.recovered, []);
});
