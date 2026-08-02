// input:  auth login service factory and stub LoginFlow consumers
// output: Auth selection, notice reuse, and cancellation regressions
// pos:    Tests the shared backend login entry used by chat and Web
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import {
  createAuthLoginService,
  type AuthLoginServiceDependencies,
} from '../../src/domain/auth/login-service.js';
import type {
  AuthInteraction,
  LoginFlowConsumer,
  LoginFlowState,
  StartLoginFlowInput,
} from '../../src/domain/auth/login-flow.js';

const STATE: LoginFlowState = {
  flowId: 'flow-1',
  backend: 'claude',
  provider: 'anthropic',
  authType: 'api_key',
  step: 'prompt',
  pendingPrompt: { kind: 'secret', message: 'key' },
  notice: null,
  channel: 'slack:C1',
  sessionId: null,
  createdAt: '2030-01-01T00:00:00.000Z',
  expiresAt: '2030-01-01T00:30:00.000Z',
  outcome: null,
  error: null,
  errorCode: null,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitForStep(
  service: ReturnType<typeof createAuthLoginService>,
  flowId: string,
  step: LoginFlowState['step'],
): Promise<LoginFlowState> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = service.getState(flowId);
    if (state?.step === step) return state;
    await setImmediate();
  }
  throw new Error(`Flow ${flowId} did not reach ${step}.`);
}

function consumer(
  provider: string,
  authType: StartLoginFlowInput['authType'],
): LoginFlowConsumer {
  return async (_interaction: AuthInteraction) => ({ provider, authType, expiresAt: null });
}

function makeDependencies() {
  const calls: Array<{ input: StartLoginFlowInput; consumer: LoginFlowConsumer }> = [];
  const claude = consumer('anthropic', 'api_key');
  const claudeOAuth = consumer('anthropic', 'oauth');
  const pi = consumer('deepseek', 'api_key');
  const piOAuth = consumer('openai-codex', 'oauth');
  const dependencies: AuthLoginServiceDependencies = {
    startFlow: async (input, selectedConsumer) => {
      calls.push({ input, consumer: selectedConsumer });
      return {
        ...STATE,
        backend: input.backend,
        provider: input.provider,
        authType: input.authType,
        channel: input.channel,
        sessionId: input.sessionId,
      };
    },
    getFlowState: flowId => flowId === 'flow-1' ? STATE : null,
    respondPrompt: async (flowId, value) => ({ ...STATE, flowId, step: value ? 'running' : 'prompt' }),
    cancelFlow: async flowId => ({ ...STATE, flowId, step: 'cancelled' }),
    claudeConsumer: claude,
    claudeOAuthConsumer: claudeOAuth,
    piConsumerFactory: provider => provider === 'deepseek' ? pi : consumer(provider, 'api_key'),
    piOAuthConsumerFactory: provider => (
      provider === 'openai-codex' ? piOAuth : consumer(provider, 'oauth')
    ),
  };
  return { calls, claude, claudeOAuth, pi, piOAuth, dependencies };
}

test('shared login service normalizes Claude and selects the Claude consumer', async () => {
  const fixture = makeDependencies();
  const service = createAuthLoginService(fixture.dependencies);

  const state = await service.start({
    backend: 'claude', provider: 'anthropic', authType: 'api_key',
    channel: 'slack:C1', sessionId: null,
  });

  assert.equal(state.backend, 'claude');
  assert.deepEqual(fixture.calls[0].input, {
    backend: 'claude', provider: 'anthropic', authType: 'api_key',
    channel: 'slack:C1', sessionId: null,
  });
  assert.equal(fixture.calls[0].consumer, fixture.claude);
});

test('shared login service selects a provider-specific PI consumer', async () => {
  const fixture = makeDependencies();
  const service = createAuthLoginService(fixture.dependencies);

  await service.start({
    backend: 'pi', provider: 'deepseek', authType: 'api_key',
    channel: null, sessionId: null,
  });

  assert.equal(fixture.calls[0].consumer, fixture.pi);
});

test('shared login service selects both OAuth consumers without replacing API-key DI', async () => {
  const fixture = makeDependencies();
  const service = createAuthLoginService(fixture.dependencies);

  await service.start({
    backend: 'claude', provider: 'anthropic', authType: 'oauth',
    channel: 'slack:C1', sessionId: null,
  });
  await service.start({
    backend: 'pi', provider: 'openai-codex', authType: 'oauth',
    channel: null, sessionId: null,
  });

  assert.equal(fixture.calls[0].consumer, fixture.claudeOAuth);
  assert.equal(fixture.calls[1].consumer, fixture.piOAuth);
});

test('shared login service rejects unsupported targets before starting a flow', async () => {
  const fixture = makeDependencies();
  const service = createAuthLoginService(fixture.dependencies);

  await assert.rejects(
    () => service.start({
      backend: 'claude', provider: 'deepseek', authType: 'api_key',
      channel: null, sessionId: null,
    }),
    (error: any) => error?.code === 'provider_not_found',
  );
  await assert.rejects(
    () => service.start({
      backend: 'pi', provider: '', authType: 'api_key', channel: null, sessionId: null,
    }),
    (error: any) => error?.code === 'provider_not_found',
  );
  await assert.rejects(
    () => service.start({
      backend: 'claude', provider: 'deepseek', authType: 'oauth',
      channel: null, sessionId: null,
    }),
    (error: any) => error?.code === 'provider_not_found',
  );
  assert.equal(fixture.calls.length, 0);
});

test('shared login service rejects reuse owned by another channel surface', async () => {
  const fixture = makeDependencies();
  fixture.dependencies.startFlow = async () => ({
    ...STATE,
    channel: 'slack:C1',
  });
  const service = createAuthLoginService(fixture.dependencies);

  await assert.rejects(
    () => service.start({
      backend: 'claude', provider: 'anthropic', authType: 'api_key',
      channel: null, sessionId: null,
    }),
    (error: any) => error?.code === 'flow_conflict',
  );
});

test('shared login service rejects pair reuse with a different auth type', async () => {
  const blockingConsumer = (authType: StartLoginFlowInput['authType']): LoginFlowConsumer => (
    async interaction => {
      await interaction.prompt({ type: 'secret', message: 'credential' });
      return { provider: 'anthropic', authType, expiresAt: null };
    }
  );
  const service = createAuthLoginService({
    claudeConsumer: blockingConsumer('api_key'),
    claudeOAuthConsumer: blockingConsumer('oauth'),
  });
  const first = await service.start({
    backend: 'claude', provider: 'anthropic', authType: 'api_key',
    channel: 'slack:C1', sessionId: null,
  });
  await waitForStep(service, first.flowId, 'prompt');

  try {
    await assert.rejects(
      () => service.start({
        backend: 'claude', provider: 'anthropic', authType: 'oauth',
        channel: 'slack:C1', sessionId: null,
      }),
      (error: any) => error?.code === 'flow_conflict',
    );
    const reused = await service.start({
      backend: 'claude', provider: 'anthropic', authType: 'oauth',
      channel: 'slack:C1', sessionId: null,
    }, { reuseExistingPair: true });
    assert.equal(reused.flowId, first.flowId);
    assert.equal(reused.authType, 'api_key');
  } finally {
    await service.cancel(first.flowId);
  }
});

test('shared login service rejects cancellation after credential handoff begins', async () => {
  const fixture = makeDependencies();
  let cancelCalls = 0;
  fixture.dependencies.cancelFlow = async flowId => {
    cancelCalls += 1;
    return { ...STATE, flowId, step: 'cancelled' };
  };
  const service = createAuthLoginService(fixture.dependencies);

  await service.respond('flow-1', 'sentinel');
  await assert.rejects(
    () => service.cancel('flow-1'),
    (error: any) => error?.code === 'flow_conflict',
  );
  assert.equal(cancelCalls, 0);
});

test('blocked credential persistence cannot be reported as cancelled after handoff', async () => {
  const writer = deferred();
  let persisted = false;
  const service = createAuthLoginService({
    claudeConsumer: async interaction => {
      await interaction.prompt({ type: 'secret', message: 'key' });
      await writer.promise;
      persisted = true;
      return { provider: 'anthropic', authType: 'api_key', expiresAt: null };
    },
  });
  const started = await service.start({
    backend: 'claude', provider: 'anthropic', authType: 'api_key', channel: null, sessionId: null,
  });
  await waitForStep(service, started.flowId, 'prompt');
  await service.respond(started.flowId, 'sentinel');
  await assert.rejects(
    () => service.respond(started.flowId, 'duplicate'),
    /not waiting for a prompt response/,
  );

  await assert.rejects(() => service.cancel(started.flowId), (error: any) => error?.code === 'flow_conflict');
  assert.equal(service.getState(started.flowId)?.step, 'running');
  writer.resolve();
  assert.equal((await waitForStep(service, started.flowId, 'done')).step, 'done');
  assert.equal(persisted, true);
});

test('shared login service delegates state, response, and cancellation exactly', async () => {
  const fixture = makeDependencies();
  const service = createAuthLoginService(fixture.dependencies);

  assert.equal(service.getState('flow-1'), STATE);
  assert.equal(service.getState('missing'), null);
  assert.equal((await service.cancel('flow-1')).step, 'cancelled');
  assert.equal((await service.respond('flow-1', 'sentinel')).step, 'running');
});
