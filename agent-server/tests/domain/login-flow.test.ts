import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  LOGIN_FLOW_TTL_MS,
  LoginFlowError,
  cancelFlow,
  getFlowState,
  isLoginFlowError,
  respondPrompt,
  startFlow,
  type AuthInteraction,
  type LoginFlowState,
  type LoginOutcome,
  type StartLoginFlowInput,
} from '../../src/domain/auth/login-flow.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface SignalProbe {
  flow: LoginFlowState;
  signal: AbortSignal | undefined;
  aborted: Promise<unknown>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function input(provider: string): StartLoginFlowInput {
  return {
    backend: 'pi', provider, authType: 'api_key',
    channel: 'web:session-1', sessionId: 'session-1',
  };
}

function outcome(provider: string, detail?: string): LoginOutcome {
  return { provider, authType: 'api_key', expiresAt: null, ...(detail ? { detail } : {}) };
}

async function delayedOutcome(release: Deferred<void>, provider: string): Promise<LoginOutcome> {
  await release.promise;
  return outcome(provider);
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

function requireState(flowId: string): LoginFlowState {
  const state = getFlowState(flowId);
  assert.ok(state, `missing flow ${flowId}`);
  return state;
}

async function startSignalProbe(provider: string): Promise<SignalProbe> {
  const aborted = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const flow = await startFlow(input(provider), async (interaction) => {
    signal = interaction.signal;
    assert.ok(signal);
    await new Promise<void>((resolve) => {
      signal!.addEventListener('abort', () => {
        aborted.resolve(signal!.reason);
        resolve();
      }, { once: true });
    });
    return outcome(provider);
  });
  await flush();
  return { flow, signal, aborted: aborted.promise };
}

afterEach(() => {
  vi.useRealTimers();
});

test('startFlow supersedes an unfinished flow for the same backend and provider', async () => {
  const release = deferred<void>();
  let promptError: unknown;
  let firstSignal: AbortSignal | undefined;
  let duplicateRuns = 0;
  const first = await startFlow(input('same-pair'), async (interaction) => {
    firstSignal = interaction.signal;
    try {
      await interaction.prompt({ type: 'secret', message: 'API key' });
    } catch (error) {
      promptError = error;
    }
    return outcome('same-pair');
  });
  const other = await startFlow(
    input('other-provider'), () => delayedOutcome(release, 'other-provider'),
  );
  const otherBackend = await startFlow(
    { ...input('same-pair'), backend: 'claude' },
    () => delayedOutcome(release, 'same-pair'),
  );
  await flush();
  const duplicate = await startFlow(
    { ...input('same-pair'), authType: 'oauth', channel: null, sessionId: null },
    async () => {
      duplicateRuns += 1;
      return delayedOutcome(release, 'same-pair');
    },
  );
  await flush();

  assert.notEqual(duplicate.flowId, first.flowId);
  assert.equal(duplicate.authType, 'oauth');
  assert.equal(duplicate.channel, null);
  assert.equal(duplicateRuns, 1);
  const superseded = requireState(first.flowId);
  assert.equal(superseded.step, 'cancelled');
  assert.equal(superseded.pendingPrompt, null);
  assert.equal(firstSignal?.aborted, true);
  assert.equal((promptError as Error).name, 'AbortError');
  assert.equal(requireState(other.flowId).step, 'running');
  assert.equal(requireState(otherBackend.flowId).step, 'running');
  release.resolve();
  await flush();
  assert.equal(requireState(duplicate.flowId).step, 'done');
});

test('a flow waiting after a response (device code) can be cancelled and replaced', async () => {
  let aborted = 0;
  const waitForBrowser = (signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal?.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); }, { once: true });
  });
  const consumer = async (interaction: AuthInteraction) => {
    await interaction.prompt({ type: 'select', message: 'Method', options: [{ id: 'device', label: 'Device' }] });
    interaction.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.test/device' });
    await waitForBrowser(interaction.signal);
    return outcome('device-wait');
  };
  const flow = await startFlow(input('device-wait'), consumer);
  await flush();
  await respondPrompt(flow.flowId, 'device');
  await flush();
  assert.equal(requireState(flow.flowId).notice?.kind, 'device_code');

  assert.equal((await cancelFlow(flow.flowId)).step, 'cancelled');
  await flush();
  assert.equal(aborted, 1);

  const second = await startFlow(input('device-wait'), consumer);
  await flush();
  await respondPrompt(second.flowId, 'device');
  await flush();
  const third = await startFlow(input('device-wait'), consumer);
  await flush();
  assert.notEqual(third.flowId, second.flowId);
  assert.equal(requireState(second.flowId).step, 'cancelled');
  assert.equal(aborted, 2);
  await cancelFlow(third.flowId);
});

test('consumer rejection keeps the first line of its reason and releases the active pair', async () => {
  const flow = await startFlow(input('consumer-failure'), async () => {
    throw new Error('ECONNRESET socket hang up\n    at TLSSocket (node:_tls_wrap)');
  });
  const silent = await startFlow(input('consumer-silent'), async () => {
    throw new Error('');
  });
  await flush();

  const failed = requireState(flow.flowId);
  assert.equal(failed.step, 'failed');
  assert.equal(failed.error, 'Login failed: ECONNRESET socket hang up');
  assert.equal(requireState(silent.flowId).error, 'Login failed.');
  assert.equal(failed.outcome, null);
  assert.equal(failed.errorCode, null);
  const replacement = await startFlow(
    input('consumer-failure'), async () => outcome('consumer-failure'),
  );
  assert.notEqual(replacement.flowId, flow.flowId);
});

test('a failure reason and its log line never repeat a submitted secret', async () => {
  const secret = 'sk-live-0123456789abcdef';
  const logged: unknown[][] = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args); });
  }
  try {
    const flow = await startFlow(input('echoing-provider'), async (interaction) => {
      const key = await interaction.prompt({ type: 'secret', message: 'API key' });
      throw new Error(`invalid API key: ${key.trim()}\n    at check (provider.js:1:1)`);
    });
    await flush();
    await respondPrompt(flow.flowId, ` ${secret} `);
    await flush();

    assert.equal(requireState(flow.flowId).error, 'Login failed: invalid API key: ***');
    assert.ok(JSON.stringify(logged).includes('invalid API key: ***'));
    assert.equal(JSON.stringify([requireState(flow.flowId), logged]).includes(secret), false);
  } finally {
    vi.restoreAllMocks();
  }
});

test('branded LoginFlowError exposes only safe message and code', async () => {
  const causeSecret = '\uE204\uE205-sensitive-consumer-cause';
  const stackSecret = '\uE206\uE207-sensitive-consumer-stack';
  const safeError = new LoginFlowError('unknown_provider', 'Unknown provider: atlas');
  safeError.cause = new Error(causeSecret);
  safeError.stack = `${safeError.stack}\n${stackSecret}`;
  assert.equal(isLoginFlowError(safeError), true);
  assert.equal(isLoginFlowError({ name: 'LoginFlowError', code: 'fake' }), false);

  const flow = await startFlow(input('safe-failure'), async () => { throw safeError; });
  await flush();

  const failed = requireState(flow.flowId);
  const serialized = JSON.stringify(failed);
  assert.equal(failed.step, 'failed');
  assert.equal(failed.error, 'Unknown provider: atlas');
  assert.equal(failed.errorCode, 'unknown_provider');
  assert.equal(failed.outcome, null);
  assert.equal(serialized.includes(causeSecret), false);
  assert.equal(serialized.includes(stackSecret), false);
});

test('a flow expires at 30 minutes and rejects its pending answer', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  let promptError: unknown;
  const flow = await startFlow(input('expiring'), async (interaction) => {
    try {
      await interaction.prompt({ type: 'secret', message: 'API key' });
    } catch (error) {
      promptError = error;
    }
    return outcome('expiring');
  });
  await flush();

  assert.equal(Date.parse(flow.expiresAt) - Date.parse(flow.createdAt), LOGIN_FLOW_TTL_MS);
  await vi.advanceTimersByTimeAsync(LOGIN_FLOW_TTL_MS);
  assert.equal(getFlowState(flow.flowId), null);
  await assert.rejects(async () => respondPrompt(flow.flowId, 'late-value'), /not found or expired/i);
  assert.equal((promptError as Error).name, 'AbortError');

  const replacement = await startFlow(input('expiring'), async () => outcome('expiring'));
  assert.notEqual(replacement.flowId, flow.flowId);
});

test('AuthInteraction resolves all four prompt types with metadata-only state', async () => {
  const answers: string[] = [];
  const flow = await startFlow(input('all-prompts'), async (interaction) => {
    answers.push(await interaction.prompt({ type: 'text', message: 'Account', placeholder: 'name' }));
    answers.push(await interaction.prompt({ type: 'secret', message: 'API key', placeholder: 'secret' }));
    answers.push(await interaction.prompt({
      type: 'select', message: 'Region',
      options: [{ id: 'us', label: 'US', description: 'United States' }],
    }));
    answers.push(await interaction.prompt({ type: 'manual_code', message: 'Code', placeholder: 'paste' }));
    return outcome('all-prompts');
  });

  const expected = [
    { kind: 'text', message: 'Account', placeholder: 'name' },
    { kind: 'secret', message: 'API key', placeholder: 'secret' },
    { kind: 'select', message: 'Region', options: [{ id: 'us', label: 'US', description: 'United States' }] },
    { kind: 'manual_code', message: 'Code', placeholder: 'paste' },
  ];
  for (const [index, value] of ['alice', 'key-value', 'us', 'manual-value'].entries()) {
    await flush();
    const { id, ...prompt } = requireState(flow.flowId).pendingPrompt!;
    assert.equal(id, requireState(flow.flowId).revision);
    assert.deepEqual(prompt, expected[index]);
    await respondPrompt(flow.flowId, value);
  }
  await flush();

  assert.deepEqual(answers, ['alice', 'key-value', 'us', 'manual-value']);
  assert.equal(requireState(flow.flowId).step, 'done');
  assert.equal(requireState(flow.flowId).pendingPrompt, null);
});

test('successful consumers store defensive receipt metadata', async () => {
  const result = outcome('receipt-provider', 'Stored by provider');
  result.expiresAt = '2030-02-03T04:05:06.000Z';
  const flow = await startFlow(input('receipt-provider'), async () => result);
  await flush();

  const completed = requireState(flow.flowId);
  assert.equal(completed.step, 'done');
  assert.deepEqual(completed.outcome, result);
  assert.equal(completed.error, null);
  assert.equal(completed.errorCode, null);

  result.detail = 'mutated consumer value';
  completed.outcome!.detail = 'mutated snapshot value';
  assert.equal(requireState(flow.flowId).outcome?.detail, 'Stored by provider');
});

test('AuthPrompt signal rejects both pre-aborted and pending prompts', async () => {
  const release = deferred<void>();
  const preAborted = AbortSignal.abort();
  const pending = new AbortController();
  const errors: Error[] = [];
  let flowSignal: AbortSignal | undefined;
  const flow = await startFlow(input('prompt-abort'), async (interaction) => {
    flowSignal = interaction.signal;
    for (const signal of [preAborted, pending.signal]) {
      try {
        await interaction.prompt({ type: 'manual_code', message: 'Code', signal });
      } catch (error) {
        errors.push(error as Error);
      }
    }
    await release.promise;
    return outcome('prompt-abort');
  });
  await flush();
  assert.equal(errors[0]?.name, 'AbortError');
  assert.equal(requireState(flow.flowId).pendingPrompt?.kind, 'manual_code');
  pending.abort();
  await flush();
  assert.deepEqual(errors.map(error => error.name), ['AbortError', 'AbortError']);
  assert.equal(requireState(flow.flowId).pendingPrompt, null);
  assert.equal(requireState(flow.flowId).step, 'running');
  assert.equal(flowSignal?.aborted, false);
  release.resolve();
  await flush();
});

test('cancelFlow rejects a pending prompt and releases the pair', async () => {
  let promptError: unknown;
  const flow = await startFlow(input('cancelled'), async (interaction) => {
    try {
      await interaction.prompt({ type: 'secret', message: 'API key' });
    } catch (error) {
      promptError = error;
    }
    return outcome('cancelled');
  });
  await flush();

  const cancelled = await cancelFlow(flow.flowId);
  await flush();
  assert.equal(cancelled.step, 'cancelled');
  assert.equal(cancelled.pendingPrompt, null);
  assert.equal((promptError as Error).name, 'AbortError');
  assert.equal(requireState(flow.flowId).step, 'cancelled');
  const replacement = await startFlow(input('cancelled'), async () => outcome('cancelled'));
  assert.notEqual(replacement.flowId, flow.flowId);
});

test('cancelFlow aborts the flow-wide signal without a pending prompt', async () => {
  const probe = await startSignalProbe('flow-cancel-signal');
  assert.ok(probe.signal, 'AuthInteraction.signal must be present');

  const result = cancelFlow(probe.flow.flowId);
  assert.equal(result instanceof Promise, true);
  const cancelled = await result;
  const reason = await probe.aborted;
  assert.equal(cancelled.step, 'cancelled');
  assert.equal(probe.signal.aborted, true);
  assert.equal((reason as Error).name, 'AbortError');
});

test('exact TTL expiry aborts the flow-wide signal without a pending prompt', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  const probe = await startSignalProbe('flow-expiry-signal');
  assert.ok(probe.signal, 'AuthInteraction.signal must be present');

  await vi.advanceTimersByTimeAsync(LOGIN_FLOW_TTL_MS);
  const reason = await probe.aborted;
  assert.equal(probe.signal.aborted, true);
  assert.equal((reason as Error).name, 'AbortError');
  assert.equal(getFlowState(probe.flow.flowId), null);
});

test('a submitted secret only resolves the consumer and never enters observable state', async () => {
  const release = deferred<void>();
  const secret = '\uE200\uE201-unique-secret-value';
  let received: string | undefined;
  const consoleCalls: unknown[][] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { consoleCalls.push(args); });
  vi.spyOn(console, 'info').mockImplementation((...args) => { consoleCalls.push(args); });
  vi.spyOn(console, 'warn').mockImplementation((...args) => { consoleCalls.push(args); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { consoleCalls.push(args); });
  const flow = await startFlow(input('privacy'), async (interaction) => {
    received = await interaction.prompt({ type: 'secret', message: 'API key' });
    return delayedOutcome(release, 'privacy');
  });
  await flush();

  const responseState = await respondPrompt(flow.flowId, secret);
  await flush();
  assert.equal(received, secret);
  assert.equal(JSON.stringify(responseState).includes(secret), false);
  assert.equal(JSON.stringify(getFlowState(flow.flowId)).includes(secret), false);
  assert.equal(JSON.stringify(consoleCalls).includes(secret), false);
  release.resolve();
  await flush();
  assert.equal(JSON.stringify(getFlowState(flow.flowId)).includes(secret), false);
  const settled = requireState(flow.flowId);
  assert.equal(settled.step, 'done');
  assert.equal(settled.outcome?.provider, 'privacy');
});

test('snapshots are defensive and invalid prompt responses are rejected', async () => {
  const release = deferred<void>();
  const flow = await startFlow(input('defensive-copy'), async (interaction) => {
    await interaction.prompt({
      type: 'select', message: 'Choose',
      options: [{ id: 'one', label: 'One' }],
    });
    return delayedOutcome(release, 'defensive-copy');
  });
  await flush();

  const snapshot = requireState(flow.flowId);
  snapshot.pendingPrompt!.message = 'mutated';
  snapshot.pendingPrompt!.options!.push({ id: 'two', label: 'Two' });
  assert.equal(requireState(flow.flowId).pendingPrompt?.message, 'Choose');
  assert.equal(requireState(flow.flowId).pendingPrompt?.options?.length, 1);
  await assert.rejects(async () => respondPrompt('missing-flow', 'value'), /not found or expired/i);

  await respondPrompt(flow.flowId, 'one');
  await flush();
  await assert.rejects(async () => respondPrompt(flow.flowId, 'again'), /not waiting/i);
  release.resolve();
  await flush();
  await assert.rejects(async () => respondPrompt(flow.flowId, 'after-done'), /not active/i);
});
