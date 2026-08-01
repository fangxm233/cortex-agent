// input:  LoginFlow API, fake consumers, fake timers
// output: Lifecycle, outcome, abort, and privacy tests
// pos:    Backend-neutral login flow regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  LOGIN_FLOW_TTL_MS,
  cancelFlow,
  getFlowState,
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
  return {
    provider, authType: 'api_key', expiresAt: null,
    ...(detail ? { detail } : {}),
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

function requireState(flowId: string): LoginFlowState {
  const state = getFlowState(flowId);
  assert.ok(state, `missing flow ${flowId}`);
  return state;
}

function assertInfoAndAuthNotices(flowId: string, interaction: AuthInteraction): void {
  interaction.notify({ type: 'info', message: 'Open provider', links: [{ url: 'https://example.test', label: 'Help' }] });
  assert.deepEqual(requireState(flowId).notice, {
    kind: 'info', message: 'Open provider', links: [{ url: 'https://example.test', label: 'Help' }],
  });
  interaction.notify({ type: 'auth_url', url: 'https://example.test/auth', instructions: 'Sign in' });
  assert.deepEqual(requireState(flowId).notice, {
    kind: 'auth_url', url: 'https://example.test/auth', instructions: 'Sign in',
  });
}

function assertDeviceAndProgressNotices(flowId: string, interaction: AuthInteraction): void {
  interaction.notify({
    type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.test/device',
    intervalSeconds: 5, expiresInSeconds: 600,
  });
  assert.deepEqual(requireState(flowId).notice, {
    kind: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.test/device',
    intervalSeconds: 5, expiresInSeconds: 600,
  });
  interaction.notify({ type: 'progress', message: 'Waiting for authorization' });
  assert.deepEqual(requireState(flowId).notice, {
    kind: 'progress', message: 'Waiting for authorization',
  });
}

async function startSignalProbe(provider: string): Promise<SignalProbe> {
  const aborted = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const flow = await startFlow(input(provider), async (interaction) => {
    signal = interaction.signal;
    assert.ok(signal);
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
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

test('startFlow reuses one active flow per backend and provider', async () => {
  const release = deferred<void>();
  let firstRuns = 0;
  let duplicateRuns = 0;
  const first = await startFlow(input('same-pair'), async () => {
    firstRuns += 1;
    await release.promise;
    return outcome('same-pair');
  });
  const duplicate = await startFlow(input('same-pair'), async () => {
    duplicateRuns += 1;
    return outcome('same-pair');
  });
  const other = await startFlow(input('other-provider'), async () => {
    await release.promise;
    return outcome('other-provider');
  });
  const otherBackend = await startFlow(
    { ...input('same-pair'), backend: 'claude' },
    async () => {
      await release.promise;
      return outcome('same-pair');
    },
  );
  await flush();

  assert.equal(duplicate.flowId, first.flowId);
  assert.notEqual(other.flowId, first.flowId);
  assert.notEqual(otherBackend.flowId, first.flowId);
  assert.equal(firstRuns, 1);
  assert.equal(duplicateRuns, 0);
  release.resolve();
  await flush();
});

test('consumer rejection exposes only the error message and releases the active pair', async () => {
  const causeSecret = '\uE202\uE203-sensitive-consumer-cause';
  const stackSecret = '\uE204\uE205-sensitive-consumer-stack';
  const publicMessage = 'Provider rejected the login request.';
  const flow = await startFlow(input('consumer-failure'), async () => {
    const error = new Error(publicMessage, { cause: new Error(causeSecret) });
    error.stack = `${error.stack}\n${stackSecret}`;
    throw error;
  });
  await flush();

  const failed = requireState(flow.flowId);
  const serialized = JSON.stringify(failed);
  assert.equal(failed.step, 'failed');
  assert.equal(failed.error, publicMessage);
  assert.equal(failed.outcome, null);
  assert.equal(serialized.includes(causeSecret), false);
  assert.equal(serialized.includes(stackSecret), false);
  const replacement = await startFlow(
    input('consumer-failure'), async () => outcome('consumer-failure'),
  );
  assert.notEqual(replacement.flowId, flow.flowId);
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
    { kind: 'text', message: 'Account' },
    { kind: 'secret', message: 'API key' },
    { kind: 'select', message: 'Region', options: [{ id: 'us', label: 'US', description: 'United States' }] },
    { kind: 'manual_code', message: 'Code' },
  ];
  for (const [index, value] of ['alice', 'key-value', 'us', 'manual-value'].entries()) {
    await flush();
    assert.deepEqual(requireState(flow.flowId).pendingPrompt, expected[index]);
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

  result.detail = 'mutated consumer value';
  completed.outcome!.detail = 'mutated snapshot value';
  assert.equal(requireState(flow.flowId).outcome?.detail, 'Stored by provider');
});

test('AuthInteraction maps all four notify variants without a channel dependency', async () => {
  const release = deferred<void>();
  let interaction: AuthInteraction | undefined;
  const flow = await startFlow(input('all-notices'), async (value) => {
    interaction = value;
    await release.promise;
    return outcome('all-notices');
  });
  await flush();
  assert.ok(interaction);

  assertInfoAndAuthNotices(flow.flowId, interaction);
  assertDeviceAndProgressNotices(flow.flowId, interaction);
  release.resolve();
  await flush();
});

test('progress notifications never create a pending prompt', async () => {
  const release = deferred<void>();
  let interaction: AuthInteraction | undefined;
  const flow = await startFlow(input('progress-notice'), async (value) => {
    interaction = value;
    await release.promise;
    return outcome('progress-notice');
  });
  await flush();
  assert.ok(interaction);

  interaction.notify({ type: 'progress', message: 'Waiting for provider approval' });
  const state = requireState(flow.flowId);
  assert.deepEqual(state.notice, { kind: 'progress', message: 'Waiting for provider approval' });
  assert.equal(state.pendingPrompt, null);
  release.resolve();
  await flush();
});

test('AuthPrompt signal rejects both pre-aborted and pending prompts', async () => {
  const release = deferred<void>();
  const preAborted = new AbortController();
  const pending = new AbortController();
  preAborted.abort();
  const errors: Error[] = [];
  let flowSignal: AbortSignal | undefined;
  const flow = await startFlow(input('prompt-abort'), async (interaction) => {
    flowSignal = interaction.signal;
    for (const signal of [preAborted.signal, pending.signal]) {
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
  assert.equal(requireState(flow.flowId).outcome, null);
  const replacement = await startFlow(input('cancelled'), async () => outcome('cancelled'));
  assert.notEqual(replacement.flowId, flow.flowId);
});

test('cancelFlow wakes a consumer waiting between prompts', async () => {
  let interactionSignal: AbortSignal | undefined;
  let consumerExited = false;
  const flow = await startFlow(input('between-prompts'), async (interaction) => {
    interactionSignal = interaction.signal;
    await interaction.prompt({ type: 'secret', message: 'API key' });
    assert.ok(interaction.signal);
    await waitForAbort(interaction.signal);
    consumerExited = true;
    return outcome('between-prompts');
  });
  await flush();

  await respondPrompt(flow.flowId, 'submitted-key');
  await flush();
  assert.equal(requireState(flow.flowId).step, 'running');
  assert.equal(interactionSignal?.aborted, false);

  const cancelled = await cancelFlow(flow.flowId);
  await flush();
  assert.equal(interactionSignal?.aborted, true);
  assert.equal(consumerExited, true);
  assert.equal(cancelled.step, 'cancelled');
  assert.equal(requireState(flow.flowId).outcome, null);
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

test('startFlow and respondPrompt expose the frozen Promise contract', async () => {
  const release = deferred<void>();
  const startResult = startFlow(input('promise-contract'), async (interaction) => {
    await interaction.prompt({ type: 'text', message: 'Account' });
    await release.promise;
    return outcome('promise-contract');
  });
  assert.equal(startResult instanceof Promise, true);
  const flow = await startResult;
  await flush();

  const responseResult = respondPrompt(flow.flowId, 'alice');
  assert.equal(responseResult instanceof Promise, true);
  assert.equal((await responseResult).step, 'running');
  release.resolve();
  await flush();
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
    await release.promise;
    return outcome('privacy', 'Stored by provider');
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
  const completed = requireState(flow.flowId);
  assert.equal(completed.step, 'done');
  assert.deepEqual(completed.outcome, outcome('privacy', 'Stored by provider'));
  assert.equal(JSON.stringify(completed).includes(secret), false);
});

test('snapshots are defensive and invalid prompt responses are rejected', async () => {
  const release = deferred<void>();
  const flow = await startFlow(input('defensive-copy'), async (interaction) => {
    await interaction.prompt({
      type: 'select', message: 'Choose',
      options: [{ id: 'one', label: 'One' }],
    });
    await release.promise;
    return outcome('defensive-copy');
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
