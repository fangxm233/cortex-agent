// input:  Claude stream/result usage and configured models
// output: exact context and cache-read accounting regressions
// pos:    Claude print usage telemetry contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  ClaudeContextUsageTracker,
  inferClaudeContextWindow,
} from '../../src/agent-adapter/claude/context-usage.js';
import { _test } from '../../src/agent-adapter/claude/adapter.js';

function messageStart(
  model: string,
  usage: Record<string, unknown> = {
    input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 300,
  },
): unknown {
  return {
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg_1', model, usage } },
  };
}

function messageDelta(outputTokens: unknown): unknown {
  return {
    type: 'stream_event',
    event: { type: 'message_delta', usage: { output_tokens: outputTokens } },
  };
}

function resultEvent(opts: {
  modelUsage?: Record<string, unknown>;
  iterations?: unknown[];
  aggregateUsage?: Record<string, unknown>;
}): unknown {
  return {
    type: 'result',
    modelUsage: opts.modelUsage,
    usage: {
      ...(opts.aggregateUsage ?? {}),
      ...(opts.iterations === undefined ? {} : { iterations: opts.iterations }),
    },
  };
}

const finalIteration = (outputTokens = 80) => ({
  input_tokens: 100,
  cache_creation_input_tokens: 20,
  cache_read_input_tokens: 300,
  output_tokens: outputTokens,
});

describe('inferClaudeContextWindow', () => {
  test('uses 1M only for an exact lowercase [1m] model-name suffix', () => {
    assert.equal(inferClaudeContextWindow('claude-opus-5[1m]'), 1_000_000);
    assert.equal(inferClaudeContextWindow('claude-opus-5[1m]-preview'), 200_000);
    assert.equal(inferClaudeContextWindow('claude-opus-5[1M]'), 200_000);
  });

  test('defaults every other or missing model name to 200K', () => {
    assert.equal(inferClaudeContextWindow('claude-sonnet-4-6'), 200_000);
    assert.equal(inferClaudeContextWindow(null), 200_000);
    assert.equal(inferClaudeContextWindow(undefined), 200_000);
  });
});

describe('ClaudeContextUsageTracker stream boundaries', () => {
  test('emits exact input occupancy at message_start and input plus output at message_delta', () => {
    const tracker = new ClaudeContextUsageTracker('claude-opus-5[1m]');

    assert.deepEqual(tracker.observe(messageStart('claude-opus-5')), {
      usedTokens: 420,
      contextWindow: 1_000_000,
      percent: 0.042,
      accuracy: 'exact',
    });
    assert.deepEqual(tracker.observe(messageDelta(80)), {
      usedTokens: 500,
      contextWindow: 1_000_000,
      percent: 0.05,
      accuracy: 'exact',
    });
  });

  test('does not clamp occupancy above 100 percent', () => {
    const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    assert.deepEqual(tracker.observe(messageStart('claude-sonnet-4-6', {
      input_tokens: 210_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })), {
      usedTokens: 210_000,
      contextWindow: 200_000,
      percent: 105,
      accuracy: 'exact',
    });
  });

  test('deduplicates repeated boundary snapshots', () => {
    const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    tracker.observe(messageStart('claude-sonnet-4-6'));
    assert.ok(tracker.observe(messageDelta(80)));
    assert.equal(tracker.observe(messageDelta(80)), null);
  });

  test('overflowing token arithmetic is rejected as malformed telemetry', () => {
    const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    assert.equal(tracker.observe(messageStart('claude-sonnet-4-6', {
      input_tokens: Number.MAX_VALUE,
      cache_creation_input_tokens: Number.MAX_VALUE,
      cache_read_input_tokens: Number.MAX_VALUE,
    })), null);
  });

  test('a malformed new message_start clears the previous call cursor', () => {
    const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    tracker.observe(messageStart('claude-sonnet-4-6'));
    assert.equal(tracker.observe(messageStart('claude-sonnet-4-6', {
      input_tokens: -1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })), null);
    assert.equal(tracker.observe(messageDelta(50)), null, 'delta must not reuse the prior call input');
  });
});

describe('ClaudeContextUsageTracker result reconciliation', () => {
  test('corrects the default after the first result and reuses the actual window next turn', () => {
    const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    tracker.observe(messageStart('claude-sonnet-4-6'));
    tracker.observe(messageDelta(80));

    assert.deepEqual(tracker.observe(resultEvent({
      modelUsage: {
        'gateway-sonnet': { canonicalModel: 'claude-sonnet-4-6', contextWindow: 240_000 },
      },
      iterations: [finalIteration()],
    })), {
      usedTokens: 500,
      contextWindow: 240_000,
      percent: 500 / 240_000 * 100,
      accuracy: 'exact',
    });

    assert.deepEqual(tracker.observe(messageStart('claude-sonnet-4-6', {
      input_tokens: 120_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })), {
      usedTokens: 120_000,
      contextWindow: 240_000,
      percent: 50,
      accuracy: 'exact',
    });
  });

  test('matches a multi-model result by the active assistant canonical model', () => {
    const tracker = new ClaudeContextUsageTracker('claude-opus-5[1m]');
    tracker.observe(messageStart('claude-opus-5'));

    assert.deepEqual(tracker.observe(resultEvent({
      modelUsage: {
        'claude-sonnet-4-6': { canonicalModel: 'claude-sonnet-4-6', contextWindow: 200_000 },
        'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 900_000 },
      },
      iterations: [finalIteration()],
    })), {
      usedTokens: 500,
      contextWindow: 900_000,
      percent: 500 / 900_000 * 100,
      accuracy: 'exact',
    });
  });

  test('active canonical model outranks the configured model when both appear', () => {
    const tracker = new ClaudeContextUsageTracker('claude-opus-5[1m]');
    tracker.observe(messageStart('claude-sonnet-4-6'));

    assert.deepEqual(tracker.observe(resultEvent({
      modelUsage: {
        'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 1_000_000 },
        'claude-sonnet-4-6': { canonicalModel: 'claude-sonnet-4-6', contextWindow: 240_000 },
      },
      iterations: [finalIteration()],
    })), {
      usedTokens: 500,
      contextWindow: 240_000,
      percent: 500 / 240_000 * 100,
      accuracy: 'exact',
    });
  });

  test('matches the configured raw model key when partial message_start is unavailable', () => {
    const tracker = new ClaudeContextUsageTracker('claude-opus-5[1m]');

    assert.deepEqual(tracker.observe(resultEvent({
      modelUsage: {
        'claude-sonnet-4-6': { canonicalModel: 'claude-sonnet-4-6', contextWindow: 200_000 },
        'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 1_100_000 },
      },
      iterations: [finalIteration()],
    })), {
      usedTokens: 500,
      contextWindow: 1_100_000,
      percent: 500 / 1_100_000 * 100,
      accuracy: 'exact',
    });
  });

  test('uses the final iteration as a guarded fallback but never the top-level turn aggregate', () => {
    const withIteration = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    assert.deepEqual(withIteration.observe(resultEvent({
      iterations: [finalIteration(100)],
      aggregateUsage: {
        input_tokens: 999_999,
        cache_creation_input_tokens: 999_999,
        cache_read_input_tokens: 999_999,
        output_tokens: 999_999,
      },
    })), {
      usedTokens: 520,
      contextWindow: 200_000,
      percent: 0.26,
      accuracy: 'exact',
    });

    const aggregateOnly = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    assert.equal(aggregateOnly.observe(resultEvent({
      aggregateUsage: { input_tokens: 999_999, output_tokens: 999_999 },
    })), null);
  });

  test('compaction invalidates the old call until the next message_start recalibrates it', () => {
    const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    tracker.observe(messageStart('claude-sonnet-4-6'));
    tracker.observe(messageDelta(80));
    assert.equal(tracker.observe({ type: 'system', subtype: 'compact_boundary' }), null);
    assert.equal(tracker.observe(resultEvent({
      modelUsage: {
        'claude-sonnet-4-6': { canonicalModel: 'claude-sonnet-4-6', contextWindow: 240_000 },
      },
      iterations: [finalIteration()],
    })), null, 'pre-compaction final iteration must not re-emit stale occupancy');

    assert.deepEqual(tracker.observe(messageStart('claude-sonnet-4-6', {
      input_tokens: 30_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })), {
      usedTokens: 30_000,
      contextWindow: 240_000,
      percent: 12.5,
      accuracy: 'exact',
    });
  });

  test('ignores malformed actual windows and malformed final iterations', () => {
    const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6');
    assert.equal(tracker.observe(resultEvent({
      modelUsage: {
        'claude-sonnet-4-6': { canonicalModel: 'claude-sonnet-4-6', contextWindow: 0 },
      },
      iterations: [{ input_tokens: 100, output_tokens: Number.NaN }],
    })), null);

    assert.deepEqual(tracker.observe(messageStart('claude-sonnet-4-6')), {
      usedTokens: 420,
      contextWindow: 200_000,
      percent: 0.21,
      accuracy: 'exact',
    });
  });
});

describe('ClaudeContextUsageTracker auto-compact window', () => {
  test('caps the inferred window at the configured auto-compact window', () => {
    const tracker = new ClaudeContextUsageTracker('claude-opus-5[1m]', 350_000);

    assert.deepEqual(tracker.observe(messageStart('claude-opus-5')), {
      usedTokens: 420,
      contextWindow: 350_000,
      percent: 420 / 350_000 * 100,
      accuracy: 'exact',
    });
  });

  test('keeps a model window that is already smaller than the auto-compact window', () => {
    const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6', 350_000);

    assert.deepEqual(tracker.observe(messageStart('claude-sonnet-4-6')), {
      usedTokens: 420,
      contextWindow: 200_000,
      percent: 0.21,
      accuracy: 'exact',
    });
  });

  test('caps the reconciled result window instead of restoring the full model window', () => {
    const tracker = new ClaudeContextUsageTracker('claude-opus-5[1m]', 350_000);
    tracker.observe(messageStart('claude-opus-5'));

    assert.deepEqual(tracker.observe(resultEvent({
      modelUsage: {
        'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 1_000_000 },
      },
      iterations: [finalIteration()],
    })), {
      usedTokens: 500,
      contextWindow: 350_000,
      percent: 500 / 350_000 * 100,
      accuracy: 'exact',
    });
  });

  test('ignores an unset or malformed auto-compact window', () => {
    for (const malformed of [null, undefined, 0, -1, Number.NaN]) {
      const tracker = new ClaudeContextUsageTracker('claude-sonnet-4-6', malformed);
      assert.deepEqual(tracker.observe(messageStart('claude-sonnet-4-6')), {
        usedTokens: 420,
        contextWindow: 200_000,
        percent: 0.21,
        accuracy: 'exact',
      }, `malformed: ${String(malformed)}`);
    }
  });
});

const FAKE_STREAM = { write() {}, end() {} } as any;

function fakeTurn(overrides: Record<string, unknown> = {}): any {
  return {
    resolve: () => {}, reject: () => {},
    resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0,
    onProgress: null, onAssistantMessage: null, onAssistantDelta: null,
    onToolUse: null, onToolResult: null, onCompact: null, onContextUsage: null,
    rawStream: FAKE_STREAM, txtStream: FAKE_STREAM, killed: false,
    ...overrides,
  };
}

describe('ClaudeSession context usage wiring', () => {
  test('preserves cache-inclusive prompt and cached token accounting', (t) => {
    const session: any = _test.makeSessionForTest('claude-sonnet-4-6');
    t.onTestFinished(() => session.close());
    session.preserveUnreportedAccounting = true;
    let resolved: any = null;
    session.currentTurn = fakeTurn({ resolve: (value: any) => { resolved = value; } });

    session.handleLine(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'test-session', total_cost_usd: 0.08, num_turns: 1,
      usage: {
        input_tokens: 1_000, output_tokens: 200,
        cache_creation_input_tokens: 30, cache_read_input_tokens: 40,
      },
      modelUsage: { 'claude-sonnet-4-6': {} }, result: 'done',
    }));

    assert.deepEqual(resolved.reportedAccounting, {
      usageReported: true, inputTokens: 1_000, outputTokens: 200,
      promptTokens: 1_000 + 30 + 40, cachedTokens: 40,
      model: 'claude-sonnet-4-6',
    });
  });

  test('forwards stream snapshots and reconciles the result window before resolving', (t) => {
    const session: any = _test.makeSessionForTest('claude-opus-5[1m]');
    t.onTestFinished(() => session.close());
    const order: string[] = [];
    session.currentTurn = fakeTurn({
      onContextUsage: (usage: { usedTokens: number; contextWindow: number }) => {
        order.push(`context:${usage.usedTokens}/${usage.contextWindow}`);
      },
      resolve: () => order.push('resolve'),
    });

    session.handleLine(JSON.stringify(messageStart('claude-opus-5')));
    session.handleLine(JSON.stringify(messageDelta(80)));
    session.handleLine(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'test-session', total_cost_usd: 0, num_turns: 1,
      modelUsage: {
        'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 900_000 },
      },
      usage: { iterations: [finalIteration()] },
      result: 'done',
    }));

    assert.deepEqual(order, [
      'context:420/1000000',
      'context:500/1000000',
      'context:500/900000',
      'resolve',
    ]);
  });

  test('keeps the session denominator on the auto-compact window across the result', (t) => {
    const session: any = _test.makeSessionForTest('claude-opus-5[1m]', 350_000);
    t.onTestFinished(() => session.close());
    const seen: string[] = [];
    session.currentTurn = fakeTurn({
      onContextUsage: (usage: { usedTokens: number; contextWindow: number }) => {
        seen.push(`context:${usage.usedTokens}/${usage.contextWindow}`);
      },
    });

    session.handleLine(JSON.stringify(messageStart('claude-opus-5')));
    session.handleLine(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'test-session', total_cost_usd: 0, num_turns: 1,
      modelUsage: {
        'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 1_000_000 },
      },
      usage: { iterations: [finalIteration()] },
      result: 'done',
    }));

    assert.deepEqual(seen, ['context:420/350000', 'context:500/350000']);
  });

  test('a throwing context callback cannot break the stream or result path', (t) => {
    const session: any = _test.makeSessionForTest('claude-sonnet-4-6');
    t.onTestFinished(() => session.close());
    let resolved = false;
    session.currentTurn = fakeTurn({
      onContextUsage: () => { throw new Error('telemetry consumer failed'); },
      resolve: () => { resolved = true; },
    });

    assert.doesNotThrow(() => session.handleLine(JSON.stringify(messageStart('claude-sonnet-4-6'))));
    assert.doesNotThrow(() => session.handleLine(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'test-session', total_cost_usd: 0, num_turns: 1,
      usage: { iterations: [finalIteration()] }, result: 'done',
    })));
    assert.equal(resolved, true);
  });
});
