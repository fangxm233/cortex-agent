// input:  PI login adapter, LoginFlow, EventBus, fake runtime
// output: PI api-key login, failures, recovery, and privacy tests
// pos:    PI api-key login adapter regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { EventBus } from '../../src/events/event-bus.js';
import type { CortexEvent } from '../../src/events/index.js';
import {
  initAuthEvents,
  publishAuthRequired,
} from '../../src/domain/auth/auth-events.js';
import {
  createPiApiKeyLoginConsumer,
  loginPiApiKey,
  type PiApiKeyLoginDependencies,
} from '../../src/domain/auth/pi-login.js';
import {
  getFlowState,
  respondPrompt,
  startFlow,
  type AuthInteraction,
} from '../../src/domain/auth/login-flow.js';
import type {
  PiCredential,
  PiModelRuntime,
  PiProvider,
  PiRuntimeLoadResult,
} from '../../src/domain/auth/pi-runtime.js';

const writeFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: writeFileSyncMock };
});

const SECRET = '\uE301\uE302-login-secret';

function provider(id = 'deepseek', supportsLogin = true): PiProvider {
  return {
    id,
    name: id,
    auth: { apiKey: supportsLogin ? { login: vi.fn() } : {} },
  };
}

function runtime(
  providers: readonly PiProvider[],
  login: PiModelRuntime['login'],
): PiModelRuntime {
  return {
    getProviders: () => providers,
    getProviderAuthStatus: () => ({ configured: false }),
    login,
  };
}

function available(value: PiModelRuntime): PiRuntimeLoadResult {
  return {
    available: true,
    version: 'fixture',
    entry: '/fixture/pi.js',
    error: null,
    runtime: value,
    readStoredCredential: () => undefined,
  };
}

function dependencies(
  value: PiRuntimeLoadResult,
  refreshProviders = vi.fn(),
): PiApiKeyLoginDependencies {
  return {
    loadRuntime: vi.fn(async () => value),
    refreshProviders,
  };
}

function interaction(answer = SECRET): AuthInteraction {
  return {
    prompt: vi.fn(async () => answer),
    notify: vi.fn(),
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

async function waitForStep(flowId: string, expected: 'done' | 'failed'): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    if (getFlowState(flowId)?.step === expected) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail(`flow ${flowId} did not reach ${expected}`);
}

function startInput(providerId: string) {
  return {
    backend: 'pi' as const,
    provider: providerId,
    authType: 'api_key' as const,
    channel: 'web:session-1',
    sessionId: 'session-1',
  };
}

function spyOnConsole(): unknown[][] {
  const calls: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => { calls.push(args); });
  }
  return calls;
}

afterEach(() => {
  initAuthEvents(null);
  writeFileSyncMock.mockReset();
  vi.restoreAllMocks();
});

test('PI login delegates storage to ModelRuntime and returns a secret-free receipt', async () => {
  const login = vi.fn(async (_id, _type, auth: AuthInteraction): Promise<PiCredential> => ({
    type: 'api_key', key: await auth.prompt({ type: 'secret', message: 'API key' }),
  }));
  const refreshProviders = vi.fn();
  const deps = dependencies(available(runtime([provider()], login)), refreshProviders);
  const recovered: CortexEvent[] = [];
  const bus = new EventBus();
  bus.subscribe('auth.recovered', event => { recovered.push(event); });
  initAuthEvents(bus);
  publishAuthRequired({
    backend: 'pi', provider: 'deepseek', authType: 'api_key', kind: 'invalid_api_key',
    channel: 'web:session-1', sessionId: 'session-1',
  });

  const auth = interaction();
  const result = await loginPiApiKey('deepseek', auth, deps);

  assert.deepEqual(result, {
    ok: true, provider: 'deepseek', authType: 'api_key', expiresAt: null,
  });
  assert.deepEqual(login.mock.calls[0], ['deepseek', 'api_key', auth]);
  assert.deepEqual(vi.mocked(deps.loadRuntime!).mock.calls, [[]], 'pi-login must use the loader default authPath');
  assert.equal(refreshProviders.mock.calls.length, 1);
  assert.equal(recovered.length, 1);
  assert.equal(writeFileSyncMock.mock.calls.length, 0, 'Cortex must not write auth.json');
  assert.equal(JSON.stringify({ result, recovered }).includes(SECRET), false);
});

test('PI login consumer drives LoginFlow to done without retaining the key', async () => {
  let received: string | null = null;
  const login = vi.fn(async (_id, _type, auth: AuthInteraction): Promise<PiCredential> => {
    received = await auth.prompt({ type: 'secret', message: 'Enter provider key' });
    return { type: 'api_key', key: received };
  });
  const deps = dependencies(available(runtime([provider()], login)));
  const flow = startFlow(startInput('deepseek'), createPiApiKeyLoginConsumer('deepseek', deps));
  await flush();

  assert.equal(getFlowState(flow.flowId)?.pendingPrompt?.kind, 'secret');
  respondPrompt(flow.flowId, SECRET);
  await waitForStep(flow.flowId, 'done');

  const done = getFlowState(flow.flowId);
  assert.equal(received, SECRET);
  assert.equal(done?.step, 'done');
  assert.equal(JSON.stringify(done).includes(SECRET), false);
});

async function assertStructuredFailure(
  expectedCode: string,
  providerId: string,
  deps: PiApiKeyLoginDependencies,
): Promise<void> {
  const result = await loginPiApiKey(providerId, interaction(), deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, expectedCode);
  assert.equal(JSON.stringify(result).includes(SECRET), false);

  const flow = startFlow(startInput(providerId), createPiApiKeyLoginConsumer(providerId, deps));
  await waitForStep(flow.flowId, 'failed');
}

test('runtime and provider failures are structured and fail the flow', async () => {
  const unavailable: PiRuntimeLoadResult = {
    available: false, version: null, entry: null,
    error: 'pi executable not found', runtime: null, readStoredCredential: null,
  };
  const inertLogin = vi.fn(async (): Promise<PiCredential> => ({ type: 'api_key' }));
  await assertStructuredFailure('runtime_unavailable', 'deepseek', dependencies(unavailable));
  await assertStructuredFailure(
    'provider_not_found', 'missing', dependencies(available(runtime([], inertLogin))),
  );
  await assertStructuredFailure(
    'api_key_login_unsupported', 'ambient',
    dependencies(available(runtime([provider('ambient', false)], inertLogin))),
  );
  assert.equal(inertLogin.mock.calls.length, 0);
});

test('runtime rejection for an invalid key is sanitized and never unhandled', async (context) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  context.onTestFinished(() => { process.off('unhandledRejection', onUnhandled); });
  const consoleCalls = spyOnConsole();
  const login = vi.fn(async (_id, _type, auth: AuthInteraction): Promise<PiCredential> => {
    const key = await auth.prompt({ type: 'secret', message: 'API key' });
    throw new Error(`invalid key: ${key}`);
  });
  const deps = dependencies(available(runtime([provider()], login)));
  const direct = await loginPiApiKey('deepseek', interaction(), deps);
  assert.deepEqual(direct, {
    ok: false,
    provider: 'deepseek',
    authType: 'api_key',
    error: { code: 'login_failed', message: 'PI API-key login failed.' },
  });

  const flow = startFlow(startInput('deepseek'), createPiApiKeyLoginConsumer('deepseek', deps));
  await flush();
  respondPrompt(flow.flowId, SECRET);
  await waitForStep(flow.flowId, 'failed');
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(getFlowState(flow.flowId)?.step, 'failed');
  assert.equal(JSON.stringify({ direct, state: getFlowState(flow.flowId), consoleCalls }).includes(SECRET), false);
  assert.deepEqual(unhandled, []);
});
