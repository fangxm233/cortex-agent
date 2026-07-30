// input:  fake adapters, continuation context, runtime settings
// output: normalized callbacks and typed-notice regressions
// pos:    Covers backend-neutral event dispatch
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { _test as modeManagerTest, isRetryableResult } from '../src/domain/agents/index.js';
import type { AgentAdapter, AgentProcess, AgentSpawnConfig, Backend, UserMessage } from '../src/agent-adapter/index.js';
import { CAPABILITIES_BY_BACKEND } from '../src/agent-adapter/index.js';
import type { NormalizedEvent } from '../src/agent-adapter/normalize/event-types.js';
import type { AgentResult } from '../src/core/types/agent-types.js';
import { getLocale, setLocale } from '../src/core/i18n.js';

const { runWithAdapter } = modeManagerTest;

// --- Fake adapter infrastructure ---

interface FakeProcessSpec {
  /** Events to emit in order (push into stream as soon as send() is called). */
  events: NormalizedEvent[];
  /** If present, send() resolves with this AgentResult after emitting events. */
  resultOnResolve?: AgentResult;
  /** If present, send() rejects with this error after emitting events (overrides resultOnResolve). */
  errorOnReject?: Error & { cancelled?: boolean };
  /** Track calls; populated by the fake. */
  recorded: { sendCalls: UserMessage[]; killed: boolean; closed: boolean };
}

function makeFakeProcess(spec: FakeProcessSpec): AgentProcess {
  const buffer: NormalizedEvent[] = [];
  const waiters: Array<(r: IteratorResult<NormalizedEvent>) => void> = [];
  let closed = false;

  const push = (e: NormalizedEvent): void => {
    if (closed) return;
    const w = waiters.shift();
    if (w) w({ value: e, done: false });
    else buffer.push(e);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    while (waiters.length) waiters.shift()!({ value: undefined as unknown as NormalizedEvent, done: true });
  };

  const events: AsyncIterable<NormalizedEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<NormalizedEvent>> {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as unknown as NormalizedEvent, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return {
    sessionKey: 'fake-key',
    sessionId: 'fake-session-id',
    async send(message: UserMessage): Promise<AgentResult> {
      spec.recorded.sendCalls.push(message);
      for (const e of spec.events) push(e);
      if (spec.errorOnReject) {
        close();
        throw spec.errorOnReject;
      }
      const result = spec.resultOnResolve ?? defaultAgentResult('fake-session-id');
      return result;
    },
    events,
    async close(): Promise<void> {
      spec.recorded.closed = true;
      close();
    },
    kill(): boolean {
      spec.recorded.killed = true;
      close();
      return true;
    },
  };
}

function makeFakeAdapter(backend: Backend, spec: FakeProcessSpec): AgentAdapter {
  return {
    backend,
    capabilities: CAPABILITIES_BY_BACKEND[backend],
    spawn(_config: AgentSpawnConfig): AgentProcess {
      return makeFakeProcess(spec);
    },
    async close(_key: string): Promise<void> {},
    kill(_key: string): boolean { return false; },
    listSessions(): string[] { return []; },
  };
}

function defaultAgentResult(sessionId: string): AgentResult {
  return {
    sessionId,
    total_cost_usd: 0,
    num_turns: 1,
    rateLimited: false,
    rateLimitMessage: null,
    planFilePath: null,
    enteredPlanMode: false,
    exitedPlanMode: false,
    finalOutput: null,
  };
}

// --- Happy path: assistant_text + tool_use + turn_complete dispatch to callbacks in order ---

test('runWithAdapter: assistant_text / tool_use / turn_complete drive callbacks in order and AgentResult flows through', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const result = defaultAgentResult('s-happy');
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'assistant_text', text: 'hello' },
      { type: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'assistant_text', text: 'done' },
      { type: 'turn_complete', numTurns: 2, totalCostUsd: 0.01 },
    ],
    resultOnResolve: result,
    recorded,
  });

  const assistantMsgs: string[] = [];
  const toolCalls: Array<{ name: string; input: any; toolUseId?: string }> = [];
  const toolResults: Array<{ toolUseId: string; content: string; isError: boolean }> = [];
  const progressCalls: Array<{ num_turns: number | null; total_cost_usd: number | null; duration_ms: number | null }> = [];

  const handle = runWithAdapter(
    adapter,
    'user msg',
    {
      channel: 'C1',
      onAssistantMessage: (t: string) => assistantMsgs.push(t),
      onToolUse: (name: string, input: any, toolUseId?: string) => toolCalls.push({ name, input, toolUseId }),
      onToolResult: (toolUseId: string, content: string, isError: boolean) => toolResults.push({ toolUseId, content, isError }),
      onProgress: (p: any) => progressCalls.push(p),
    },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );

  const final = await handle.promise;

  assert.deepEqual(assistantMsgs, ['hello', 'done'], 'assistant_text events preserve order');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'Bash');
  assert.deepEqual(toolCalls[0].input, { command: 'ls' });
  assert.equal(toolCalls[0].toolUseId, 't1', 'the correlation id is preserved');
  assert.deepEqual(toolResults, [], 'no result callback is invented without a tool_result event');
  assert.equal(progressCalls.length, 1, 'onProgress fires exactly once on turn_complete');
  assert.deepEqual(progressCalls[0], { num_turns: 2, total_cost_usd: 0.01, duration_ms: null });
  assert.equal(final, result, 'handle.promise resolves with the exact AgentResult from send()');
  assert.equal(recorded.sendCalls.length, 1);
  assert.equal(recorded.closed, true, 'proc.close() called in the runWithAdapter finally block');
});

test('runWithAdapter: context_usage reaches the backend-neutral callback before progress', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const adapter = makeFakeAdapter('pi', {
    events: [
      { type: 'context_usage', usedTokens: 60000, contextWindow: 200000, percent: 30, accuracy: 'estimate' },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.01 },
    ],
    resultOnResolve: defaultAgentResult('s-context'),
    recorded,
  });
  const seen: string[] = [];

  await runWithAdapter(
    adapter,
    'msg',
    {
      channel: 'web:context',
      onContextUsage: (usage) => { seen.push(`context:${usage.usedTokens}/${usage.contextWindow}`); },
      onProgress: () => seen.push('progress'),
    },
    { model: 'm', backend: 'pi', mode: null },
    undefined,
  ).promise;

  assert.deepEqual(seen, ['context:60000/200000', 'progress']);
});

test('runWithAdapter: context compaction emits one concise info notice', async (t) => {
  const previousFlag = process.env.CORTEX_NOTIFY_COMPACTION;
  const previousLocale = getLocale();
  t.onTestFinished(() => {
    if (previousFlag === undefined) delete process.env.CORTEX_NOTIFY_COMPACTION;
    else process.env.CORTEX_NOTIFY_COMPACTION = previousFlag;
    setLocale(previousLocale);
  });
  process.env.CORTEX_NOTIFY_COMPACTION = '1';
  setLocale('en');

  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'context_compacted', trigger: 'overflow', preTokens: 48000 },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
    ],
    resultOnResolve: defaultAgentResult('s-compact'),
    recorded,
  });
  const notices: Array<{ text: string; level?: string }> = [];

  await runWithAdapter(
    adapter,
    'msg',
    {
      channel: 'C1',
      onAssistantMessage: (text: string, _blockId?: string, level?: string) => notices.push({ text, level }),
    },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  ).promise;

  assert.deepEqual(notices, [{ text: 'Context auto-compacted.', level: 'info' }]);
});

test('runWithAdapter: a leading API Error becomes an error notice without reclassifying prose', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'assistant_text', text: 'API Error: Unable to connect to API (ECONNRESET)' },
      { type: 'assistant_text', text: 'The log mentions API Error: timeout.' },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
    ],
    resultOnResolve: defaultAgentResult('s-api-error'),
    recorded,
  });
  const notices: Array<{ text: string; level?: string }> = [];

  await runWithAdapter(
    adapter,
    'msg',
    {
      channel: 'web:session',
      onAssistantMessage: (text: string, _blockId?: string, level?: string) => notices.push({ text, level }),
    },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  ).promise;

  assert.deepEqual(notices, [
    { text: 'API Error: Unable to connect to API (ECONNRESET)', level: 'error' },
    { text: 'The log mentions API Error: timeout.', level: undefined },
  ]);
});

test('runWithAdapter: changed backend identity on resume emits one warning, same/fresh starts emit none', async (t) => {
  const previousLocale = getLocale();
  t.onTestFinished(() => setLocale(previousLocale));
  setLocale('en');

  const collect = async (
    requestedSessionId: string | null,
    startedSessionId: string,
    channel = 'web:session',
  ) => {
    const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
    const adapter = makeFakeAdapter('pi', {
      events: [
        { type: 'session_started', sessionId: startedSessionId },
        { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
      ],
      resultOnResolve: defaultAgentResult(startedSessionId),
      recorded,
    });
    const notices: Array<{ text: string; level?: string }> = [];

    await runWithAdapter(
      adapter,
      'msg',
      {
        channel,
        sessionId: requestedSessionId,
        onAssistantMessage: (text: string, _blockId?: string, level?: string) => notices.push({ text, level }),
      },
      { model: 'm', backend: 'pi', mode: null },
      undefined,
    ).promise;
    return notices;
  };

  assert.deepEqual(await collect('backend-old', 'backend-new'), [{
    text: 'Previous backend session was unavailable; started a fresh session.',
    level: 'warning',
  }]);
  assert.deepEqual(await collect('backend-same', 'backend-same'), []);
  assert.deepEqual(await collect(null, 'backend-new'), []);
  assert.deepEqual(await collect('backend-old', 'backend-new', 'slack:C1'), []);
});

test('runWithAdapter: tool_result preserves full multiline content, error status, and correlation id', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'tool_use', toolUseId: 'toolu-result', name: 'Read', input: { file_path: '/secret/full.ts' } },
      { type: 'tool_result', toolUseId: 'toolu-result', content: 'first line\nsecond line\nthird line', ok: false },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
    ],
    resultOnResolve: defaultAgentResult('s-result'),
    recorded,
  });
  const seen: any[] = [];

  await runWithAdapter(
    adapter,
    'msg',
    {
      channel: 'C1',
      onToolResult: (toolUseId: string, content: string, isError: boolean) => seen.push({ toolUseId, content, isError }),
    },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  ).promise;

  assert.deepEqual(seen, [{ toolUseId: 'toolu-result', content: 'first line\nsecond line\nthird line', isError: true }]);
});

// --- FIFO ordering: tool_use then assistant_text fires callbacks in that order (T2 plan-review) ---

test('runWithAdapter: tool_use → assistant_text arrives to callbacks in FIFO order', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'tool_use', toolUseId: 't1', name: 'Read', input: { file_path: '/a' } },
      { type: 'assistant_text', text: 'after tool' },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
    ],
    resultOnResolve: defaultAgentResult('s-fifo'),
    recorded,
  });

  const log: string[] = [];
  const handle = runWithAdapter(
    adapter,
    'm',
    {
      channel: 'C1',
      onAssistantMessage: (t: string) => log.push(`text:${t}`),
      onToolUse: (name: string) => log.push(`tool:${name}`),
    },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );
  await handle.promise;

  assert.deepEqual(log, ['tool:Read', 'text:after tool'], 'FIFO: tool event fires before subsequent text');
});

// --- Rate-limited path: send() resolves with rateLimited=true; outer fallback sees it (T1 Blocker) ---

test('runWithAdapter: rateLimited AgentResult passes through so runAgent outer fallback can retry', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  // Exact shape the outer runAgent loop (mode-manager.runAgent) expects; isRetryableResult reads rateLimited.
  const rateLimitedResult: AgentResult = {
    sessionId: 's-rate',
    total_cost_usd: 0,
    num_turns: 1,
    rateLimited: true,
    rateLimitMessage: 'rate limited',
    planFilePath: null,
    enteredPlanMode: false,
    exitedPlanMode: false,
    finalOutput: null,
  };
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'rate_limit', raw: { message: 'rate limited' } },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: 0 },
    ],
    resultOnResolve: rateLimitedResult,
    recorded,
  });

  const handle = runWithAdapter(
    adapter,
    'msg',
    { channel: 'C1' },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );
  const result = await handle.promise;

  assert.equal(result.rateLimited, true, 'rateLimited propagates to the resolved result');
  assert.equal(result.rateLimitMessage, 'rate limited');
  assert.equal(isRetryableResult(result), true, 'isRetryableResult matches the runAgent outer fallback trigger');
});

// --- AgentResult.askUserQuestions passthrough (T3 plan-review) ---

test('runWithAdapter: askUserQuestions on AgentResult survives through handle.promise', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const result: AgentResult = {
    ...defaultAgentResult('s-ask'),
    askUserQuestions: [
      { toolUseId: 'q-1', questions: ['Q1', 'Q2'] as any, sessionId: 's-ask' },
    ],
  };
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'ask_user_question', toolUseId: 'q-1', questions: [{ question: 'Q1' }, { question: 'Q2' }] },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
    ],
    resultOnResolve: result,
    recorded,
  });

  const handle = runWithAdapter(
    adapter,
    'msg',
    { channel: 'C1' },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );
  const final = await handle.promise;

  assert.ok(Array.isArray(final.askUserQuestions), 'askUserQuestions array present on final result');
  assert.equal(final.askUserQuestions!.length, 1);
  assert.equal(final.askUserQuestions![0].toolUseId, 'q-1');
});

// --- context_compacted: gated by CORTEX_NOTIFY_COMPACTION (default off) ---

test('runWithAdapter: context_compacted notifies via onAssistantMessage only when CORTEX_NOTIFY_COMPACTION=1', async (t) => {
  const prev = process.env.CORTEX_NOTIFY_COMPACTION;
  t.onTestFinished(() => {
    if (prev === undefined) delete process.env.CORTEX_NOTIFY_COMPACTION;
    else process.env.CORTEX_NOTIFY_COMPACTION = prev;
  });

  const makeAdapter = () => makeFakeAdapter('claude', {
    events: [
      { type: 'context_compacted', trigger: 'auto', preTokens: 37418 },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
    ],
    resultOnResolve: defaultAgentResult('s-compact'),
    recorded: { sendCalls: [], killed: false, closed: false },
  });

  // OFF (env unset): no notification.
  delete process.env.CORTEX_NOTIFY_COMPACTION;
  vi.resetModules();
  const { _test: offFacade } = await import('../src/domain/agents/index.js');
  const offMsgs: string[] = [];
  await offFacade.runWithAdapter(
    makeAdapter(), 'msg',
    { channel: 'C1', onAssistantMessage: (m: string) => offMsgs.push(m) },
    { model: 'm', backend: 'claude', mode: null }, undefined,
  ).promise;
  assert.deepEqual(offMsgs, [], 'no compaction notice when flag is off');

  // ON: exactly one concise notification; backend trigger/token details stay internal.
  process.env.CORTEX_NOTIFY_COMPACTION = '1';
  vi.resetModules();
  const { _test: onFacade } = await import('../src/domain/agents/index.js');
  const onMsgs: string[] = [];
  await onFacade.runWithAdapter(
    makeAdapter(), 'msg',
    { channel: 'C1', onAssistantMessage: (m: string) => onMsgs.push(m) },
    { model: 'm', backend: 'claude', mode: null }, undefined,
  ).promise;
  assert.deepEqual(onMsgs, ['Context auto-compacted.']);
});

// --- Thread-session inline background-task wait (2026-07-10) ---
// A thread step (options.threadId set) whose turn left background work remaining must NOT
// resolve until the spontaneous continuation completes — mirroring the interactive hold.
// Interactive turns (threadId null) keep the async lifecycle-hold path and resolve immediately.

interface SinkCapableSpec extends FakeProcessSpec { sinks: any[] }

function makeSinkCapableAdapter(backend: Backend, spec: SinkCapableSpec): AgentAdapter {
  return {
    backend,
    capabilities: CAPABILITIES_BY_BACKEND[backend],
    spawn(_config: AgentSpawnConfig): AgentProcess {
      const proc = makeFakeProcess(spec) as AgentProcess & { setContinuationSink?: (s: any) => void };
      proc.setContinuationSink = (s: any) => spec.sinks.push(s);
      return proc;
    },
    async close(_key: string): Promise<void> {},
    kill(_key: string): boolean { return false; },
    listSessions(): string[] { return []; },
  };
}

test('runWithAdapter: thread turn with pending background task waits for the continuation and merges it', async () => {
  const spec: SinkCapableSpec = {
    events: [{ type: 'turn_complete', numTurns: 1, totalCostUsd: 0.01 }],
    resultOnResolve: { ...defaultAgentResult('s-thr-bg'), total_cost_usd: 0.01, pendingBackgroundTasks: 1 },
    recorded: { sendCalls: [], killed: false, closed: false },
    sinks: [],
  };
  const adapter = makeSinkCapableAdapter('claude', spec);
  const texts: string[] = [];
  const toolResults: any[] = [];
  const contextWindows: number[] = [];

  const handle = runWithAdapter(
    adapter, 'msg',
    {
      channel: 'thread-x',
      threadId: 'thr_abc',
      onAssistantMessage: (t: string) => texts.push(t),
      onToolResult: (toolUseId: string, content: string, isError: boolean) => toolResults.push({ toolUseId, content, isError }),
      onContextUsage: (usage) => { contextWindows.push(usage.contextWindow); },
    },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );

  let resolved = false;
  void handle.promise.then(() => { resolved = true; });
  // Give the turn plenty of ticks: it must still be waiting on the continuation.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, 'thread turn held while the background task runs');
  assert.equal(spec.sinks.length, 1, 'continuation sink registered on the process');

  // Background task completes → spontaneous continuation turn ends.
  spec.sinks[0].onToolResult('toolu-bg', 'complete background output', false);
  spec.sinks[0].onAssistantText('bg result: PASS');
  spec.sinks[0].onContextUsage({ usedTokens: 500, contextWindow: 1_000_000, percent: 0.05, accuracy: 'exact' });
  spec.sinks[0].onResult({ ...defaultAgentResult('s-thr-bg'), total_cost_usd: 0.02, num_turns: 2, finalOutput: 'bg result: PASS', pendingBackgroundTasks: 0 });

  const final = await handle.promise;
  assert.ok(Math.abs((final.total_cost_usd ?? 0) - 0.03) < 1e-9, 'continuation cost merged into the step result');
  assert.equal(final.finalOutput, 'bg result: PASS', 'continuation output becomes the step output');
  assert.deepEqual(texts, ['bg result: PASS'], 'continuation text forwarded to the step stream');
  assert.deepEqual(toolResults, [{ toolUseId: 'toolu-bg', content: 'complete background output', isError: false }], 'continuation tool results use the same callback path');
  assert.deepEqual(contextWindows, [1_000_000], 'continuation context uses the same callback path');
});

test('runWithAdapter: interactive turn (no threadId) with pending background task resolves immediately', async () => {
  const spec: SinkCapableSpec = {
    events: [{ type: 'turn_complete', numTurns: 1, totalCostUsd: 0.01 }],
    resultOnResolve: { ...defaultAgentResult('s-int-bg'), pendingBackgroundTasks: 1 },
    recorded: { sendCalls: [], killed: false, closed: false },
    sinks: [],
  };
  const adapter = makeSinkCapableAdapter('claude', spec);

  const final = await runWithAdapter(
    adapter, 'msg',
    { channel: 'slack:D1' },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  ).promise;

  assert.equal(final.pendingBackgroundTasks, 1, 'interactive path returns immediately (lifecycle holds the status instead)');
  assert.equal(spec.sinks.length, 0, 'no inline sink for interactive turns');
});

// --- Error path: send() rejects; handle.promise rejects with the same error ---

test('runWithAdapter: fatal error from send() rejects handle.promise', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const err = new Error('fatal boom');
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'assistant_text', text: 'partial' },
      { type: 'error', message: 'fatal boom', fatal: true },
    ],
    errorOnReject: err,
    recorded,
  });

  const handle = runWithAdapter(
    adapter,
    'msg',
    { channel: 'C1' },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );
  await assert.rejects(handle.promise, /fatal boom/);
  assert.equal(recorded.closed, true, 'proc.close() still runs in the finally block on rejection');
});

// --- Cancellation: handle.kill() invokes proc.kill() and promise rejects ---

test('runWithAdapter: handle.kill() forwards to adapter process.kill()', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const cancelled = Object.assign(new Error('Cancelled by user'), { cancelled: true });
  const adapter = makeFakeAdapter('claude', {
    events: [],
    errorOnReject: cancelled,
    recorded,
  });

  const handle = runWithAdapter(
    adapter,
    'msg',
    { channel: 'C1' },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );
  const killed = handle.kill();
  assert.equal(killed, true, 'kill() returns the adapter.kill() result');
  assert.equal(recorded.killed, true, 'proc.kill() was invoked on the adapter process');
  // Do not await handle.promise here — errorOnReject already sealed rejection; the test below
  // catches it explicitly via assert.rejects.
  await assert.rejects(handle.promise, /Cancelled by user/);
});

// --- assistant_delta: token-level streaming dispatch (UI-only) ---

test('runWithAdapter: assistant_delta drives onAssistantDelta, interleaved with the complete message in FIFO order', async () => {
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'assistant_delta', text: 'Tea ', blockId: 'msg_A:1' },
      { type: 'assistant_delta', text: 'is a leaf.', blockId: 'msg_A:1' },
      { type: 'assistant_text', text: 'Tea is a leaf.', blockId: 'msg_A:1' },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
    ],
    resultOnResolve: defaultAgentResult('s-delta'),
    recorded,
  });

  const order: string[] = [];
  const deltas: Array<[string, string]> = [];
  const finals: Array<[string, string | undefined]> = [];

  const handle = runWithAdapter(
    adapter,
    'msg',
    {
      channel: 'web:abc',
      onAssistantDelta: (text: string, blockId: string) => { deltas.push([text, blockId]); order.push('delta'); },
      onAssistantMessage: (text: string, blockId?: string) => { finals.push([text, blockId]); order.push('final'); },
    },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );
  await handle.promise;

  assert.deepEqual(deltas, [['Tea ', 'msg_A:1'], ['is a leaf.', 'msg_A:1']]);
  assert.deepEqual(finals, [['Tea is a leaf.', 'msg_A:1']], 'the complete message carries the same blockId');
  assert.deepEqual(order, ['delta', 'delta', 'final'], 'deltas precede the authoritative message');
});

test('runWithAdapter: with no onAssistantDelta, deltas are dropped and never reach onAssistantMessage', async () => {
  // This is the Slack / Feishu / Ink-TUI guarantee: those paths pass no delta callback, so no
  // partial text can ever reach OutputStream through the assistant-message seam.
  const recorded = { sendCalls: [] as UserMessage[], killed: false, closed: false };
  const adapter = makeFakeAdapter('claude', {
    events: [
      { type: 'assistant_delta', text: 'par', blockId: 'msg_A:0' },
      { type: 'assistant_delta', text: 'tial', blockId: 'msg_A:0' },
      { type: 'assistant_text', text: 'partial', blockId: 'msg_A:0' },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: null },
    ],
    resultOnResolve: defaultAgentResult('s-nodelta'),
    recorded,
  });

  const msgs: string[] = [];
  const handle = runWithAdapter(
    adapter,
    'msg',
    { channel: 'C1', onAssistantMessage: (t: string) => msgs.push(t) },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );
  await handle.promise;

  assert.deepEqual(msgs, ['partial'], 'exactly one complete message, no partial text');
});
