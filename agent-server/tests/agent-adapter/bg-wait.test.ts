// input:  AgentResult background counts and the bg-continuation settings flag
// output: remaining-background arithmetic and the legacy inline-wait eligibility guards
// pos:    Pure wait-policy predicates. The run's own background phase (merge, watchdog,
//         completion-only stop) is specified at the engine seam in continuation-phase.test.ts;
//         `waitForBgContinuation`'s process-driven cases were that spec's legacy duplicate, so they
//         were removed with the process seam they drove.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  canAwaitBgContinuation, shouldAwaitBgInline, remainingBg,
} from '../../src/agent-adapter/bg-wait.js';
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
