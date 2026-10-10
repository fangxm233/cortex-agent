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
  revision: 1,
  backend: 'claude',
  provider: 'anthropic',
  authType: 'api_key',
  step: 'prompt',
  pendingPrompt: { id: 1, kind: 'secret', message: 'key' },
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

test('a new start supersedes an unfinished same-pair flow from any auth type or surface', async () => {
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

  const second = await service.start({
    backend: 'claude', provider: 'anthropic', authType: 'oauth', channel: null, sessionId: null,
  });
  try {
    assert.notEqual(second.flowId, first.flowId);
    assert.equal(second.authType, 'oauth');
    assert.equal(second.channel, null);
    assert.equal(service.getState(first.flowId)?.step, 'cancelled');
  } finally {
    await service.cancel(second.flowId);
  }
});

test('a multi-step flow can be cancelled again once it asks its next prompt', async () => {
  const service = createAuthLoginService({
    piConsumerFactory: provider => async interaction => {
      await interaction.prompt({ type: 'secret', message: 'key' });
      await interaction.prompt({ type: 'text', message: 'account id' });
      return { provider, authType: 'api_key', expiresAt: null };
    },
  });
  const started = await service.start({
    backend: 'pi', provider: 'cloudflare-workers-ai', authType: 'api_key', channel: null, sessionId: null,
  });
  const first = await waitForStep(service, started.flowId, 'prompt');
  await service.respond(started.flowId, 'sentinel', first.pendingPrompt!.id);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (service.getState(started.flowId)?.pendingPrompt?.kind === 'text') break;
    await setImmediate();
  }

  const cancelled = await service.cancel(started.flowId);
  assert.equal(cancelled.step, 'cancelled');
});

test('a submitted response does not block cancel or a replacement start', async () => {
  const writer = deferred();
  const service = createAuthLoginService({
    claudeConsumer: async interaction => {
      await interaction.prompt({ type: 'secret', message: 'key' });
      await writer.promise;
      return { provider: 'anthropic', authType: 'api_key', expiresAt: null };
    },
  });
  const input = { backend: 'claude', provider: 'anthropic', authType: 'api_key', channel: null, sessionId: null } as const;
  const started = await service.start(input);
  await waitForStep(service, started.flowId, 'prompt');
  await service.respond(started.flowId, 'sentinel');
  await assert.rejects(
    () => service.respond(started.flowId, 'duplicate'),
    /not waiting for a prompt response/,
  );

  assert.equal((await service.cancel(started.flowId)).step, 'cancelled');
  const replacement = await service.start(input);
  assert.notEqual(replacement.flowId, started.flowId);
  writer.resolve();
  await setImmediate();
  assert.equal(service.getState(started.flowId)?.step, 'cancelled');
  await service.cancel(replacement.flowId);
});
