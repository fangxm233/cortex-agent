// input:  background policy, fake process, timers, settings
// output: continuation eligibility, merge, and timeout tests
// pos:    Covers inline background waiting
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  canAwaitBgContinuation, waitForBgContinuation, shouldAwaitBgInline, remainingBg,
} from '../../src/agent-adapter/bg-wait.js';
import type { ContinuationSink } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import { resetSettingsForTests } from '../../src/core/settings.js';

function baseResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: 's-bg', total_cost_usd: 0.02, num_turns: 3,
    rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    finalOutput: 'base output',
    pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0,
    ...overrides,
  };
}

function fakeProc() {
  const sinks: ContinuationSink[] = [];
  return {
    sinks,
    proc: { setContinuationSink: (s: ContinuationSink) => sinks.push(s) },
    sink: () => sinks.at(-1)!,
  };
}

function fakeTimers() {
  const armed: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    armed,
    timers: {
      set: (fn: () => void, ms: number) => { const h = { fn, ms, cleared: false }; armed.push(h); return h; },
      clear: (h: any) => { if (h) h.cleared = true; },
    },
    live: () => armed.filter((h) => !h.cleared),
  };
}

test('waitForBgContinuation: registers a sink and resolves with the merged result on completion', async () => {
  const { proc, sink, sinks } = fakeProc();
  const ft = fakeTimers();
  const p = waitForBgContinuation({
    proc, baseResult: baseResult(), graceMs: 1000, maxWaitMs: 5000, timers: ft.timers,
  });
  assert.equal(sinks.length, 1, 'continuation sink registered on the process');

  sink().onResult(baseResult({
    total_cost_usd: 0.01, num_turns: 2, finalOutput: 'continuation output',
    pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0,
  }));
  const merged = await p;
  assert.equal(merged.total_cost_usd, 0.02 + 0.01, 'costs summed');
  assert.equal(merged.num_turns, 5, 'turns summed');
  assert.equal(merged.finalOutput, 'continuation output', 'latest output wins');
  assert.equal(merged.pendingBackgroundTasks, 0);
  assert.equal(ft.live().length, 0, 'timers cleared');
});

test('waitForBgContinuation: continuation text, tools, and context forward to step callbacks', async () => {
  const { proc, sink } = fakeProc();
  const ft = fakeTimers();
  const texts: string[] = [];
  const tools: string[] = [];
  const contexts: number[] = [];
  const p = waitForBgContinuation({
    proc, baseResult: baseResult(),
    onAssistantText: (t) => texts.push(t),
    onToolUse: (name) => tools.push(name),
    onContextUsage: (usage) => { contexts.push(usage.contextWindow); },
    graceMs: 1000, maxWaitMs: 5000, timers: ft.timers,
  });
  sink().onAssistantText('bg finished: OK');
  sink().onToolUse?.('Bash', { command: 'tail log' });
  sink().onContextUsage?.({
    usedTokens: 500, contextWindow: 1_000_000, percent: 0.05, accuracy: 'exact',
  });
  sink().onResult(baseResult({ pendingBackgroundTasks: 0 }));
  await p;
  assert.deepEqual(texts, ['bg finished: OK']);
  assert.deepEqual(tools, ['Bash']);
  assert.deepEqual(contexts, [1_000_000]);
});

test('waitForBgContinuation: chained continuation (still remaining) keeps waiting and merges across turns', async () => {
  const { proc, sink } = fakeProc();
  const ft = fakeTimers();
  const p = waitForBgContinuation({
    proc, baseResult: baseResult({ total_cost_usd: 0.1, num_turns: 1 }),
    graceMs: 1000, maxWaitMs: 5000, timers: ft.timers,
  });

  let resolved = false;
  void p.then(() => { resolved = true; });
  // First continuation: one more task still running.
  sink().onResult(baseResult({ total_cost_usd: 0.2, num_turns: 2, finalOutput: 'first', pendingBackgroundTasks: 1 }));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, 'still waiting while tasks remain');

  // Second continuation: done.
  sink().onResult(baseResult({ total_cost_usd: 0.3, num_turns: 3, finalOutput: 'second', pendingBackgroundTasks: 0 }));
  const merged = await p;
  assert.ok(Math.abs((merged.total_cost_usd ?? 0) - 0.6) < 1e-9, 'all three turns costed');
  assert.equal(merged.num_turns, 6);
  assert.equal(merged.finalOutput, 'second');
});

test('waitForBgContinuation: interrupted (process death) resolves with accumulated result + flag, never hangs', async () => {
  const { proc, sink } = fakeProc();
  const ft = fakeTimers();
  const p = waitForBgContinuation({ proc, baseResult: baseResult(), graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  sink().onResult({ ...baseResult({ pendingBackgroundTasks: 0 }), backgroundInterrupted: true });
  const merged = await p;
  assert.equal(merged.backgroundInterrupted, true, 'interruption surfaced to the caller');
  assert.equal(merged.finalOutput, 'base output', 'base output preserved');
});

test('waitForBgContinuation: rate-limited continuation propagates rateLimited on the merged result', async () => {
  const { proc, sink } = fakeProc();
  const ft = fakeTimers();
  const p = waitForBgContinuation({ proc, baseResult: baseResult(), graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  sink().onResult(baseResult({ rateLimited: true, rateLimitMessage: 'limit hit', pendingBackgroundTasks: 0 }));
  const merged = await p;
  assert.equal(merged.rateLimited, true);
  assert.equal(merged.rateLimitMessage, 'limit hit');
});

test('waitForBgContinuation: undelivered-only arms the grace timer; firing resolves with the base result', async () => {
  const { proc } = fakeProc();
  const ft = fakeTimers();
  const p = waitForBgContinuation({
    proc, baseResult: baseResult({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 }),
    graceMs: 1000, maxWaitMs: 5000, timers: ft.timers,
  });
  assert.equal(ft.live().length, 1);
  assert.equal(ft.live()[0].ms, 1000, 'grace timer armed');
  ft.live()[0].fn();
  const merged = await p;
  assert.equal(merged.finalOutput, 'base output');
});

test('waitForBgContinuation: running task arms the max-wait cap; firing resolves instead of blocking forever', async () => {
  const { proc } = fakeProc();
  const ft = fakeTimers();
  const p = waitForBgContinuation({
    proc, baseResult: baseResult({ pendingBackgroundTasks: 2 }),
    graceMs: 1000, maxWaitMs: 5000, timers: ft.timers,
  });
  assert.equal(ft.live().length, 1);
  assert.equal(ft.live()[0].ms, 5000, 'cap timer armed');
  ft.live()[0].fn();
  const merged = await p;
  assert.equal(merged.pendingBackgroundTasks, 2, 'remaining count preserved so the caller can log it');
});

test('waitForBgContinuation: late sink events after resolution are ignored (no double resolve / no throw)', async () => {
  const { proc, sink } = fakeProc();
  const ft = fakeTimers();
  const p = waitForBgContinuation({ proc, baseResult: baseResult(), graceMs: 1000, maxWaitMs: 5000, timers: ft.timers });
  sink().onResult(baseResult({ pendingBackgroundTasks: 0, finalOutput: 'first' }));
  const merged = await p;
  assert.doesNotThrow(() => sink().onResult(baseResult({ pendingBackgroundTasks: 0, finalOutput: 'stray' })));
  assert.equal(merged.finalOutput, 'first');
});

test('remainingBg: running + undelivered summed; absent fields are 0', () => {
  assert.equal(remainingBg(baseResult({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 2 })), 3);
  assert.equal(remainingBg(baseResult({ pendingBackgroundTasks: undefined, undeliveredBackgroundTasks: undefined })), 0);
});

test('shouldAwaitBgInline: only thread turns, claude backend, sink capability, work remaining, flag on', async () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    const r = baseResult();
    assert.equal(canAwaitBgContinuation('claude', r, true), true, 'eligible work can be explicitly awaited');
    assert.equal(canAwaitBgContinuation('pi', r, true), false, 'unsupported backends are ineligible');
    assert.equal(shouldAwaitBgInline('claude', 'thr_1', r, true), true, 'thread turn with running task waits');
    assert.equal(shouldAwaitBgInline('claude', 'thr_1', baseResult({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 }), true), true, 'undelivered-only also waits');
    assert.equal(shouldAwaitBgInline('claude', null, r, true), false, 'interactive turn (no threadId) handled by lifecycle hold instead');
    assert.equal(shouldAwaitBgInline('pi', 'thr_1', r, true), false, 'non-claude backend never waits');
    assert.equal(shouldAwaitBgInline('claude', 'thr_1', r, false), false, 'no sink capability');
    assert.equal(shouldAwaitBgInline('claude', 'thr_1', baseResult({ pendingBackgroundTasks: 0 }), true), false, 'nothing remaining');
    assert.equal(shouldAwaitBgInline('claude', 'thr_1', baseResult({ rateLimited: true }), true), false, 'rate-limited turn goes to the retry path');
    assert.equal(shouldAwaitBgInline('claude', 'thr_1', null, true), false, 'null result');
    process.env.CORTEX_BG_CONTINUATION = 'off';
    resetSettingsForTests();
    assert.equal(shouldAwaitBgInline('claude', 'thr_1', r, true), false, 'feature flag off');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
    resetSettingsForTests();
  }
});
