// input:  LoginFlow API, fake consumers, fake timers
// output: Lifecycle, bridge, abort, and privacy tests
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
  type StartLoginFlowInput,
} from '../../src/domain/auth/login-flow.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
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

async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

function requireState(flowId: string): LoginFlowState {
  const state = getFlowState(flowId);
  assert.ok(state, `missing flow ${flowId}`);
  return state;
}

afterEach(() => {
  vi.useRealTimers();
});

test('startFlow reuses one active flow per backend and provider', async () => {
  const release = deferred<void>();
  let firstRuns = 0;
  let duplicateRuns = 0;
  const first = startFlow(input('same-pair'), async () => {
    firstRuns += 1;
    await release.promise;
  });
  const duplicate = startFlow(input('same-pair'), async () => { duplicateRuns += 1; });
  const other = startFlow(input('other-provider'), async () => { await release.promise; });
  const otherBackend = startFlow(
    { ...input('same-pair'), backend: 'claude' },
    async () => { await release.promise; },
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

test('consumer rejection fails safely and releases the active pair', async () => {
  const secretInError = '\uE202\uE203-sensitive-consumer-error';
  const flow = startFlow(input('consumer-failure'), async () => {
    throw new Error(secretInError);
  });
  await flush();

  const failed = requireState(flow.flowId);
  assert.equal(failed.step, 'failed');
  assert.equal(failed.error, 'Login failed.');
  assert.equal(JSON.stringify(failed).includes(secretInError), false);
  assert.notEqual(startFlow(input('consumer-failure'), async () => {}).flowId, flow.flowId);
});

test('a flow expires at 30 minutes and rejects its pending answer', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  let promptError: unknown;
  const flow = startFlow(input('expiring'), async (interaction) => {
    try {
      await interaction.prompt({ type: 'secret', message: 'API key' });
    } catch (error) {
      promptError = error;
    }
  });
  await flush();

  assert.equal(Date.parse(flow.expiresAt) - Date.parse(flow.createdAt), LOGIN_FLOW_TTL_MS);
  await vi.advanceTimersByTimeAsync(LOGIN_FLOW_TTL_MS);
  assert.equal(getFlowState(flow.flowId), null);
  assert.throws(() => respondPrompt(flow.flowId, 'late-value'), /not found or expired/i);
  assert.equal((promptError as Error).name, 'AbortError');

  const replacement = startFlow(input('expiring'), async () => {});
  assert.notEqual(replacement.flowId, flow.flowId);
});

test('AuthInteraction resolves all four prompt types with metadata-only state', async () => {
  const answers: string[] = [];
  const flow = startFlow(input('all-prompts'), async (interaction) => {
    answers.push(await interaction.prompt({ type: 'text', message: 'Account', placeholder: 'name' }));
    answers.push(await interaction.prompt({ type: 'secret', message: 'API key', placeholder: 'secret' }));
    answers.push(await interaction.prompt({
      type: 'select', message: 'Region',
      options: [{ id: 'us', label: 'US', description: 'United States' }],
    }));
    answers.push(await interaction.prompt({ type: 'manual_code', message: 'Code', placeholder: 'paste' }));
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
    respondPrompt(flow.flowId, value);
  }
  await flush();

  assert.deepEqual(answers, ['alice', 'key-value', 'us', 'manual-value']);
  assert.equal(requireState(flow.flowId).step, 'done');
  assert.equal(requireState(flow.flowId).pendingPrompt, null);
});

test('AuthInteraction maps all three notify variants without a channel dependency', async () => {
  const release = deferred<void>();
  let interaction: AuthInteraction | undefined;
  const flow = startFlow(input('all-notices'), async (value) => {
    interaction = value;
    await release.promise;
  });
  await flush();
  assert.ok(interaction);

  interaction.notify({ type: 'info', message: 'Open the provider', links: [{ url: 'https://example.test', label: 'Help' }] });
  assert.deepEqual(requireState(flow.flowId).notice, {
    kind: 'info', message: 'Open the provider', links: [{ url: 'https://example.test', label: 'Help' }],
  });
  interaction.notify({ type: 'auth_url', url: 'https://example.test/auth', instructions: 'Sign in' });
  assert.deepEqual(requireState(flow.flowId).notice, {
    kind: 'auth_url', url: 'https://example.test/auth', instructions: 'Sign in',
  });
  interaction.notify({
    type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.test/device',
    intervalSeconds: 5, expiresInSeconds: 600,
  });
  assert.deepEqual(requireState(flow.flowId).notice, {
    kind: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.test/device',
    intervalSeconds: 5, expiresInSeconds: 600,
  });
  release.resolve();
  await flush();
});

test('AuthPrompt signal rejects both pre-aborted and pending prompts', async () => {
  const release = deferred<void>();
  const preAborted = new AbortController();
  const pending = new AbortController();
  preAborted.abort();
  const errors: Error[] = [];
  const flow = startFlow(input('prompt-abort'), async (interaction) => {
    for (const signal of [preAborted.signal, pending.signal]) {
      try {
        await interaction.prompt({ type: 'manual_code', message: 'Code', signal });
      } catch (error) {
        errors.push(error as Error);
      }
    }
    await release.promise;
  });
  await flush();
  assert.equal(errors[0]?.name, 'AbortError');
  assert.equal(requireState(flow.flowId).pendingPrompt?.kind, 'manual_code');

  pending.abort();
  await flush();
  assert.deepEqual(errors.map(error => error.name), ['AbortError', 'AbortError']);
  assert.equal(requireState(flow.flowId).pendingPrompt, null);
  release.resolve();
  await flush();
});

test('cancelFlow rejects a pending prompt and releases the pair', async () => {
  let promptError: unknown;
  const flow = startFlow(input('cancelled'), async (interaction) => {
    try {
      await interaction.prompt({ type: 'secret', message: 'API key' });
    } catch (error) {
      promptError = error;
    }
  });
  await flush();

  const cancelled = cancelFlow(flow.flowId);
  await flush();
  assert.equal(cancelled.step, 'cancelled');
  assert.equal(cancelled.pendingPrompt, null);
  assert.equal((promptError as Error).name, 'AbortError');
  assert.equal(requireState(flow.flowId).step, 'cancelled');
  assert.notEqual(startFlow(input('cancelled'), async () => {}).flowId, flow.flowId);
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
  const flow = startFlow(input('privacy'), async (interaction) => {
    received = await interaction.prompt({ type: 'secret', message: 'API key' });
    await release.promise;
  });
  await flush();

  const responseState = respondPrompt(flow.flowId, secret);
  await flush();
  assert.equal(received, secret);
  assert.equal(JSON.stringify(responseState).includes(secret), false);
  assert.equal(JSON.stringify(getFlowState(flow.flowId)).includes(secret), false);
  assert.equal(JSON.stringify(consoleCalls).includes(secret), false);
  release.resolve();
  await flush();
  assert.equal(JSON.stringify(getFlowState(flow.flowId)).includes(secret), false);
});

test('snapshots are defensive and invalid prompt responses are rejected', async () => {
  const release = deferred<void>();
  const flow = startFlow(input('defensive-copy'), async (interaction) => {
    await interaction.prompt({
      type: 'select', message: 'Choose',
      options: [{ id: 'one', label: 'One' }],
    });
    await release.promise;
  });
  await flush();

  const snapshot = requireState(flow.flowId);
  snapshot.pendingPrompt!.message = 'mutated';
  snapshot.pendingPrompt!.options!.push({ id: 'two', label: 'Two' });
  assert.equal(requireState(flow.flowId).pendingPrompt?.message, 'Choose');
  assert.equal(requireState(flow.flowId).pendingPrompt?.options?.length, 1);
  assert.throws(() => respondPrompt('missing-flow', 'value'), /not found or expired/i);

  respondPrompt(flow.flowId, 'one');
  await flush();
  assert.throws(() => respondPrompt(flow.flowId, 'again'), /not waiting/i);
  release.resolve();
  await flush();
  assert.throws(() => respondPrompt(flow.flowId, 'after-done'), /not active/i);
});
