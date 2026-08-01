// input:  PI OAuth adapter, LoginFlow, EventBus, fake runtime
// output: OAuth capability, expiry, abort, failure, and privacy tests
// pos:    PI OAuth login adapter regression tests
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
  createPiOAuthLoginConsumer,
  loginPiOAuth,
  type PiOAuthLoginDependencies,
} from '../../src/domain/auth/pi-oauth.js';
import {
  getFlowState,
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
const writeFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: writeFileSyncMock };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: writeFileMock };
});

const SECRET = '\uE401\uE402-oauth-secret';
const EXPIRES_MS = Date.parse('2031-02-03T04:05:06.000Z');

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function credential(expires: number = EXPIRES_MS): PiCredential {
  return { type: 'oauth', access: SECRET, refresh: `${SECRET}-refresh`, expires };
}

function provider(id: string, supportsOAuth = true): PiProvider {
  return {
    id,
    name: id,
    auth: { oauth: supportsOAuth ? { login: vi.fn() } : {} },
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
): PiOAuthLoginDependencies {
  return {
    loadRuntime: vi.fn(async () => value),
    refreshProviders,
  };
}

function interaction(): AuthInteraction {
  return { prompt: vi.fn(), notify: vi.fn() };
}

function startInput(providerId: string) {
  return {
    backend: 'pi' as const,
    provider: providerId,
    authType: 'oauth' as const,
    channel: 'web:session-1',
    sessionId: 'session-1',
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

function spyOnConsole(): unknown[][] {
  const calls: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => { calls.push(args); });
  }
  return calls;
}

function unavailable(): PiRuntimeLoadResult {
  return {
    available: false,
    version: null,
    entry: null,
    error: 'pi executable not found',
    runtime: null,
    readStoredCredential: null,
  };
}

function callbackLoginHarness() {
  const callbackWon = deferred<void>();
  const releaseCredential = deferred<void>();
  const observed: { promptError: Error | null; flowSignal?: AbortSignal } = { promptError: null };
  const login = vi.fn(async (_id, _type, auth: AuthInteraction): Promise<PiCredential> => {
    observed.flowSignal = auth.signal;
    auth.notify({ type: 'auth_url', url: 'https://example.test/oauth', instructions: 'Sign in' });
    const manualAbort = new AbortController();
    const manual = auth.prompt({
      type: 'manual_code', message: 'Paste redirect URL', signal: manualAbort.signal,
    }).catch((error: Error) => { observed.promptError = error; });
    await callbackWon.promise;
    manualAbort.abort();
    await manual;
    auth.notify({ type: 'progress', message: 'Callback received' });
    await releaseCredential.promise;
    return credential();
  });
  return { callbackWon, releaseCredential, observed, login };
}

afterEach(() => {
  initAuthEvents(null);
  writeFileSyncMock.mockReset();
  writeFileMock.mockReset();
  vi.restoreAllMocks();
});

test('PI OAuth capability detection delegates storage and returns the credential expiry', async () => {
  const login = vi.fn(async (): Promise<PiCredential> => credential());
  const refreshProviders = vi.fn();
  const deps = dependencies(available(runtime([provider('future-oauth')], login)), refreshProviders);
  const recovered: CortexEvent[] = [];
  const bus = new EventBus();
  bus.subscribe('auth.recovered', event => { recovered.push(event); });
  initAuthEvents(bus);
  publishAuthRequired({
    backend: 'pi', provider: 'future-oauth', authType: 'oauth', kind: 'oauth_expired',
    channel: 'web:session-1', sessionId: 'session-1',
  });

  const auth = interaction();
  const result = await loginPiOAuth('future-oauth', auth, deps);

  assert.deepEqual(result, {
    ok: true, provider: 'future-oauth', authType: 'oauth',
    expiresAt: '2031-02-03T04:05:06.000Z',
  });
  assert.deepEqual(login.mock.calls[0], ['future-oauth', 'oauth', auth]);
  assert.equal(refreshProviders.mock.calls.length, 1);
  assert.deepEqual(recovered.map(event => event.type), ['auth.recovered']);
  assert.equal(JSON.stringify({ result, recovered }).includes(SECRET), false);
  assert.equal(writeFileSyncMock.mock.calls.length, 0);
  assert.equal(writeFileMock.mock.calls.length, 0);
});

async function assertFailure(
  providerId: string,
  deps: PiOAuthLoginDependencies,
  expected: { code: string; message: string },
): Promise<void> {
  const result = await loginPiOAuth(providerId, interaction(), deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error, expected);
  const flow = await startFlow(startInput(providerId), createPiOAuthLoginConsumer(providerId, deps));
  await waitForStep(flow.flowId, 'failed');
  assert.equal(getFlowState(flow.flowId)?.errorCode, expected.code);
  assert.equal(getFlowState(flow.flowId)?.error, expected.message);
}

test('PI OAuth failures distinguish unavailable, missing, and unsupported providers', async () => {
  const inertLogin = vi.fn(async (): Promise<PiCredential> => credential());
  await assertFailure(
    'future-oauth', dependencies(unavailable()),
    { code: 'runtime_unavailable', message: 'PI runtime is unavailable.' },
  );
  await assertFailure(
    'missing', dependencies(available(runtime([], inertLogin))),
    { code: 'provider_not_found', message: 'PI provider was not found.' },
  );
  await assertFailure(
    'anthropic', dependencies(available(runtime([provider('anthropic', false)], inertLogin))),
    { code: 'oauth_unsupported', message: 'PI provider does not support OAuth login.' },
  );
  assert.equal(inertLogin.mock.calls.length, 0);
});

test('PI OAuth consumer forwards device-code and progress notices to LoginFlow', async () => {
  const deviceShown = deferred<void>();
  const finish = deferred<void>();
  const login = vi.fn(async (_id, _type, auth: AuthInteraction): Promise<PiCredential> => {
    auth.notify({
      type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.test/device',
      intervalSeconds: 5, expiresInSeconds: 600,
    });
    await deviceShown.promise;
    auth.notify({ type: 'progress', message: 'Authorization received' });
    await finish.promise;
    return credential();
  });
  const deps = dependencies(available(runtime([provider('device-provider')], login)));
  const flow = await startFlow(startInput('device-provider'), createPiOAuthLoginConsumer('device-provider', deps));
  await flush();

  assert.deepEqual(getFlowState(flow.flowId)?.notice, {
    kind: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.test/device',
    intervalSeconds: 5, expiresInSeconds: 600,
  });
  deviceShown.resolve();
  await flush();
  assert.deepEqual(getFlowState(flow.flowId)?.notice, {
    kind: 'progress', message: 'Authorization received',
  });
  finish.resolve();
  await waitForStep(flow.flowId, 'done');
});

test('an aborted manual-code prompt does not end the callback OAuth flow', async () => {
  const harness = callbackLoginHarness();
  const deps = dependencies(available(runtime([provider('callback-provider')], harness.login)));
  const consumer = createPiOAuthLoginConsumer('callback-provider', deps);
  const flow = await startFlow(startInput('callback-provider'), consumer);
  await flush();

  assert.equal(getFlowState(flow.flowId)?.pendingPrompt?.kind, 'manual_code');
  assert.equal(getFlowState(flow.flowId)?.notice?.kind, 'auth_url');
  harness.callbackWon.resolve();
  await flush();
  assert.equal(harness.observed.promptError?.name, 'AbortError');
  assert.equal(getFlowState(flow.flowId)?.step, 'running');
  assert.equal(getFlowState(flow.flowId)?.pendingPrompt, null);
  assert.equal(harness.observed.flowSignal?.aborted, false);

  harness.releaseCredential.resolve();
  await waitForStep(flow.flowId, 'done');
  assert.deepEqual(getFlowState(flow.flowId)?.outcome, {
    provider: 'callback-provider', authType: 'oauth',
    expiresAt: '2031-02-03T04:05:06.000Z',
  });
});

test('PI OAuth runtime rejection is structured, secret-free, and handled', async (context) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  context.onTestFinished(() => { process.off('unhandledRejection', onUnhandled); });
  const consoleCalls = spyOnConsole();
  const login = vi.fn(async (): Promise<PiCredential> => {
    throw new Error(`token exchange failed: ${SECRET}`);
  });
  const deps = dependencies(available(runtime([provider('broken-oauth')], login)));

  const result = await loginPiOAuth('broken-oauth', interaction(), deps);
  const flow = await startFlow(
    startInput('broken-oauth'), createPiOAuthLoginConsumer('broken-oauth', deps),
  );
  await waitForStep(flow.flowId, 'failed');
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.deepEqual(result, {
    ok: false, provider: 'broken-oauth', authType: 'oauth',
    error: { code: 'login_failed', message: 'PI OAuth login failed.' },
  });
  assert.equal(getFlowState(flow.flowId)?.errorCode, 'login_failed');
  assert.equal(getFlowState(flow.flowId)?.error, 'PI OAuth login failed.');
  assert.equal(JSON.stringify({ result, state: getFlowState(flow.flowId), consoleCalls }).includes(SECRET), false);
  assert.deepEqual(unhandled, []);
});

test('PI OAuth reports null only when the returned credential has no usable expiry', async () => {
  const withoutExpiry = {
    type: 'oauth', access: SECRET, refresh: `${SECRET}-refresh`,
  } as PiCredential;
  const login = vi.fn(async (): Promise<PiCredential> => withoutExpiry);
  const deps = dependencies(available(runtime([provider('no-expiry')], login)));

  const result = await loginPiOAuth('no-expiry', interaction(), deps);

  assert.deepEqual(result, {
    ok: true, provider: 'no-expiry', authType: 'oauth', expiresAt: null,
  });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});
