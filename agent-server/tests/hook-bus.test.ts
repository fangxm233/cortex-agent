// input:  HookBus, deferred runner mock, entries, timeout defaults
// output: HookBus matching, serial ordering, result and isolation tests
// pos:    Regression coverage for server-side hook dispatch
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { HookEntry } from '../src/store/hook-registry.js';

const runner = vi.hoisted(() => ({
  runHookProcess: vi.fn(),
}));

vi.mock('../src/core/hook-exec.js', () => ({
  runHookProcess: runner.runHookProcess,
}));

import {
  emitCortexEvent,
  initHookBus,
  type HookSpec,
} from '../src/core/hook-bus.js';

function entry(id: string, extra: Partial<HookEntry> = {}): HookEntry {
  return {
    id,
    event: 'cortex:thread.end',
    run: { command: id },
    ...extra,
  };
}

function deferredResult() {
  let resolve!: (value: { stdout: string; stderr: string }) => void;
  const promise = new Promise<{ stdout: string; stderr: string }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForCallCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 10 && runner.runHookProcess.mock.calls.length < expected; attempt++) {
    await Promise.resolve();
  }
  assert.equal(runner.runHookProcess.mock.calls.length, expected);
}

beforeEach(() => {
  runner.runHookProcess.mockReset();
  runner.runHookProcess.mockResolvedValue({ stdout: '', stderr: '' });
  initHookBus({ entries: [], hooksDir: '/test/hooks' });
});

test('runs only enabled exact-event entries whose matcher is a payload subset', async () => {
  initHookBus({ entries: [
    entry('always'),
    entry('match', { matcher: { source: 'dispatch', count: 2 } }),
    entry('value-miss', { matcher: { source: 'manual' } }),
    entry('partial-key-miss', { matcher: { source: 'dispatch', terminal: true } }),
    entry('strict-miss', { matcher: { count: '2' } }),
    entry('disabled', { enabled: false }),
    entry('wrong-event', { event: 'cortex:thread.start' }),
  ] });

  const results = await emitCortexEvent('cortex:thread.end', {
    source: 'dispatch',
    count: 2,
  });

  assert.deepEqual(results, [{ id: 'always' }, { id: 'match' }]);
  assert.deepEqual(
    runner.runHookProcess.mock.calls.map(([opts]) => opts.command),
    ['always', 'match'],
  );
});

test('runs normalized registry hooks before scoped hooks with correct timeout units', async () => {
  const env = { PATH: '/test/bin', CORTEX_TEST: '1' };
  const scopedHooks: HookSpec[] = [{
    id: 'scoped',
    command: 'scoped-command',
    args: ['first', 'second'],
    timeoutMs: 17,
    result: 'none',
  }];
  initHookBus({
    entries: [
      entry('script', { run: { script: 'script.mjs', timeout: 2 } }),
      entry('default-timeout', { run: { command: 'raw-command' } }),
    ],
    hooksDir: '/deployed hooks',
  });

  const results = await emitCortexEvent(
    'cortex:thread.end',
    { source: 'dispatch' },
    { scopedHooks, env },
  );

  assert.deepEqual(results, [
    { id: 'script' },
    { id: 'default-timeout' },
    { id: 'scoped' },
  ]);
  assert.deepEqual(runner.runHookProcess.mock.calls.map(([opts]) => opts), [
    {
      command: 'node',
      args: ['/deployed hooks/script.mjs'],
      timeoutMs: 2_000,
      stdinPayload: '{"source":"dispatch"}',
      env,
      label: 'script',
    },
    {
      command: 'raw-command',
      args: undefined,
      timeoutMs: 30_000,
      stdinPayload: '{"source":"dispatch"}',
      env,
      label: 'default-timeout',
    },
    {
      command: 'scoped-command',
      args: ['first', 'second'],
      timeoutMs: 17,
      stdinPayload: '{"source":"dispatch"}',
      env,
      label: 'scoped',
    },
  ]);
});

test('does not start a later registry or scoped hook before the prior hook settles', async () => {
  const first = deferredResult();
  const second = deferredResult();
  const scoped = deferredResult();
  runner.runHookProcess
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(scoped.promise);
  initHookBus({ entries: [entry('first'), entry('second')] });

  const emitted = emitCortexEvent('cortex:thread.end', {}, {
    scopedHooks: [{ id: 'scoped', command: 'scoped', timeoutMs: 10 }],
  });

  assert.deepEqual(runner.runHookProcess.mock.calls.map(([opts]) => opts.label), ['first']);
  first.resolve({ stdout: '', stderr: '' });
  await waitForCallCount(2);
  assert.deepEqual(runner.runHookProcess.mock.calls.map(([opts]) => opts.label), ['first', 'second']);
  second.resolve({ stdout: '', stderr: '' });
  await waitForCallCount(3);
  assert.deepEqual(
    runner.runHookProcess.mock.calls.map(([opts]) => opts.label),
    ['first', 'second', 'scoped'],
  );
  scoped.resolve({ stdout: '', stderr: '' });
  assert.deepEqual(await emitted, [{ id: 'first' }, { id: 'second' }, { id: 'scoped' }]);
});

test('uses a caller timeout default only for registry hooks that omit one', async () => {
  initHookBus({ entries: [
    entry('session-default', {
      event: 'cortex:session.messageEnd',
      run: { command: 'session-default' },
    }),
    entry('session-explicit', {
      event: 'cortex:session.messageEnd',
      run: { command: 'session-explicit', timeout: 2 },
    }),
  ] });

  await emitCortexEvent(
    'cortex:session.messageEnd',
    {},
    { defaultTimeoutMs: 60_000 },
  );

  assert.deepEqual(
    runner.runHookProcess.mock.calls.map(([opts]) => opts.timeoutMs),
    [60_000, 2_000],
  );
});

test('interprets hook-result, stdout-as-prompt, none, and omitted result modes', async () => {
  initHookBus({ entries: [
    entry('json', { result: 'hook-result' }),
    entry('prompt', { result: 'stdout-as-prompt' }),
    entry('none', { result: 'none' }),
    entry('omitted'),
  ] });
  runner.runHookProcess
    .mockResolvedValueOnce({ stdout: ' {"insertAgent":true} ', stderr: '' })
    .mockResolvedValueOnce({ stdout: '  follow up  ', stderr: '' })
    .mockResolvedValueOnce({ stdout: 'ignored', stderr: '' })
    .mockResolvedValueOnce({ stdout: 'also ignored', stderr: '' });

  const results = await emitCortexEvent('cortex:thread.end', {});

  assert.deepEqual(results, [
    { id: 'json', result: { insertAgent: true } },
    { id: 'prompt', result: 'follow up' },
    { id: 'none' },
    { id: 'omitted' },
  ]);
});

test('reports and logs each failure without rejecting or skipping later hooks', async (t) => {
  initHookBus({ entries: [
    entry('process-failure', { result: 'stdout-as-prompt' }),
    entry('bad-json', { result: 'hook-result' }),
    entry('success', { result: 'stdout-as-prompt' }),
  ] });
  runner.runHookProcess
    .mockResolvedValueOnce({ stdout: '', stderr: 'bad', error: 'exited with code 7' })
    .mockResolvedValueOnce({ stdout: 'not json', stderr: '' })
    .mockResolvedValueOnce({ stdout: 'done', stderr: '' });
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => errorLog.mockRestore());

  const results = await emitCortexEvent('cortex:thread.end', {});

  assert.deepEqual(results[0], { id: 'process-failure', error: 'exited with code 7' });
  assert.equal(results[1]?.id, 'bad-json');
  assert.match(results[1]?.error ?? '', /JSON|Unexpected token/);
  assert.deepEqual(results[2], { id: 'success', result: 'done' });
  assert.equal(runner.runHookProcess.mock.calls.length, 3);
  assert.equal(errorLog.mock.calls.length, 2);
});

test('does not serialize or spawn when an event has no subscribers', async () => {
  initHookBus({ entries: [entry('other', { event: 'cortex:thread.start' })] });
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const results = await emitCortexEvent('cortex:thread.end', circular);

  assert.deepEqual(results, []);
  assert.equal(runner.runHookProcess.mock.calls.length, 0);
});

test('reports payload serialization failure for each subscriber without spawning', async (t) => {
  initHookBus({ entries: [entry('registry')] });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => errorLog.mockRestore());

  const results = await emitCortexEvent('cortex:thread.end', circular, {
    scopedHooks: [{ id: 'scoped', command: 'scoped', timeoutMs: 10 }],
  });

  assert.deepEqual(results.map((result) => result.id), ['registry', 'scoped']);
  assert.ok(results.every((result) => /circular/i.test(result.error ?? '')));
  assert.equal(errorLog.mock.calls.length, 2);
  assert.equal(runner.runHookProcess.mock.calls.length, 0);
});
