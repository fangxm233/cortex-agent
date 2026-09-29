import { test } from 'vitest';
import assert from 'node:assert/strict';

import { replayClaudeTurns } from './replay-harness.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';

const json = (value: unknown): string => JSON.stringify(value);
const result = (totalCostUsd = 0.01, numTurns = 1): string => json({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: numTurns,
  total_cost_usd: totalCostUsd,
  result: 'done',
});

function eventsOf<T extends NormalizedEvent['type']>(events: NormalizedEvent[], type: T) {
  return events.filter((event): event is Extract<NormalizedEvent, { type: T }> => event.type === type);
}

// --- Claude production session/engine seam ---

test('Claude engine: malformed JSON is ignored without a normalized error', async () => {
  const replay = await replayClaudeTurns([['not-json', '{broken', '', result()]]);

  assert.equal(replay.error, null);
  assert.deepEqual(
    replay.normalized.filter((event) => !['session_started', 'cost_record', 'turn_complete'].includes(event.type)),
    [],
  );
});

test('Claude engine: unknown top-level type is ignored', async () => {
  const replay = await replayClaudeTurns([[json({ type: 'mystery-event' }), result()]]);

  assert.equal(replay.error, null);
  assert.equal(eventsOf(replay.normalized, 'tool_use').length, 0);
  assert.equal(eventsOf(replay.normalized, 'assistant_text').length, 0);
});

test('Claude engine: init and other system lines do not duplicate the engine start event', async () => {
  const replay = await replayClaudeTurns([[
    json({ type: 'system', subtype: 'init', session_id: 'provider-session' }),
    json({ type: 'system', subtype: 'compact' }),
    result(),
  ]]);

  assert.deepEqual(replay.events.filter((event) => event.type === 'engine_started'), [
    { type: 'engine_started', backendSessionId: 'test-session' },
  ]);
  assert.deepEqual(eventsOf(replay.normalized, 'session_started'), []);
});

test('Claude engine: turn-complete cost uses the session cumulative-cost delta', async () => {
  const replay = await replayClaudeTurns([
    [result(1.0, 3)],
    [result(1.5, 5)],
  ]);

  assert.deepEqual(eventsOf(replay.normalized, 'turn_complete'), [
    { type: 'turn_complete', numTurns: 3, totalCostUsd: 1 },
    { type: 'turn_complete', numTurns: 5, totalCostUsd: 0.5 },
  ]);
});

test('Claude engine: an inline provider error rejects the run and emits a fatal run event', async () => {
  const replay = await replayClaudeTurns([[
    json({
      type: 'result',
      subtype: 'success',
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0.01,
      result: 'provider rejected the turn',
    }),
  ]]);

  assert.equal(replay.error?.message, 'provider rejected the turn');
  assert.deepEqual(replay.events.filter((event) => event.type === 'error'), [
    { type: 'error', message: 'provider rejected the turn', fatal: true },
  ]);
  assert.equal(eventsOf(replay.normalized, 'turn_complete').length, 0);
});

test('Claude engine: rate-limit lines reach the adapter reporter seam', async () => {
  const rawInfo = { status: 'allowed', isUsingOverage: false };
  const replay = await replayClaudeTurns([[
    json({ type: 'rate_limit_event', rate_limit_info: rawInfo }),
    result(),
  ]]);

  assert.deepEqual(replay.rateLimits, [rawInfo]);
  assert.deepEqual(eventsOf(replay.normalized, 'rate_limit'), []);
});

test('Claude engine: AskUserQuestion remains a production tool_use event', async () => {
  const input = { questions: [{ question: 'Go?', multi: false, options: ['yes', 'no'] }] };
  const replay = await replayClaudeTurns([[
    json({
      type: 'assistant',
      message: { id: 'msg-ask', content: [{ type: 'tool_use', id: 'tu-ask', name: 'AskUserQuestion', input }] },
    }),
    result(),
  ]]);

  assert.deepEqual(eventsOf(replay.normalized, 'tool_use'), [{
    type: 'tool_use', toolUseId: 'tu-ask', name: 'AskUserQuestion', input,
  }]);
});

test('Claude engine: plan Write and ExitPlanMode retain production tool and derived events', async () => {
  const planPath = '/home/user/project/plan/thread-plan.md';
  const replay = await replayClaudeTurns([[
    json({
      type: 'assistant',
      message: {
        id: 'msg-write',
        content: [{
          type: 'tool_use', id: 'tu-write', name: 'Write',
          input: { file_path: planPath, content: '# Plan' },
        }],
      },
    }),
    json({
      type: 'assistant',
      message: {
        id: 'msg-exit',
        content: [{
          type: 'tool_use', id: 'tu-exit', name: 'ExitPlanMode',
          input: { plan: '# approved plan body' },
        }],
      },
    }),
    result(),
  ]]);

  assert.deepEqual(eventsOf(replay.normalized, 'tool_use').map((event) => event.name), [
    'Write', 'ExitPlanMode',
  ]);
  assert.deepEqual(eventsOf(replay.normalized, 'plan_written'), [{
    type: 'plan_written', toolUseId: '', path: planPath, content: '',
  }]);
});

test('Claude engine: thinking blocks are not normalized', async () => {
  const replay = await replayClaudeTurns([[
    json({
      type: 'assistant',
      message: { id: 'msg-thinking', content: [{ type: 'thinking', thinking: 'pondering...' }] },
    }),
    result(),
  ]]);

  assert.equal(eventsOf(replay.normalized, 'assistant_text').length, 0);
  assert.equal(eventsOf(replay.normalized, 'tool_use').length, 0);
});

test('Claude engine: tool-result content and error status use the production callback', async () => {
  const replay = await replayClaudeTurns([[
    json({
      type: 'assistant',
      message: {
        id: 'msg-tool',
        content: [{ type: 'tool_use', id: 'tu-tool', name: 'Bash', input: { command: 'false' } }],
      },
    }),
    json({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-tool', content: 'boom', is_error: true }],
      },
    }),
    result(),
  ]]);

  assert.deepEqual(eventsOf(replay.normalized, 'tool_result'), [{
    type: 'tool_result', toolUseId: 'tu-tool', ok: false, content: 'boom',
  }]);
});
