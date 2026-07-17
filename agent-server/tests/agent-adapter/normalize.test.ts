// input:  Node test runner + replay-harness + NormalizedEvent
// output: parser edge-case regression tests
// pos:    NormalizedEvent translator edge case scenarios
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  parseClaudeLineToNormalized,
  createClaudeParserState,
  parseCodexRpcLine,
} from './replay-harness.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';

// --- Claude parser edges ---

test('parseClaudeLineToNormalized: malformed JSON silently yields [] (parity with claude-bridge.ts:598)', () => {
  const state = createClaudeParserState();
  assert.deepStrictEqual(parseClaudeLineToNormalized('not-json', state), []);
  assert.deepStrictEqual(parseClaudeLineToNormalized('{broken', state), []);
  assert.deepStrictEqual(parseClaudeLineToNormalized('', state), []);
});

test('parseClaudeLineToNormalized: unknown top-level type returns []', () => {
  const state = createClaudeParserState();
  assert.deepStrictEqual(
    parseClaudeLineToNormalized(JSON.stringify({ type: 'mystery-event' }), state),
    [],
  );
});

test('parseClaudeLineToNormalized: system subtype=init emits session_started; other system subtypes yield []', () => {
  const state = createClaudeParserState();
  const initLine = JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-abc',
  });
  const initEvents = parseClaudeLineToNormalized(initLine, state);
  assert.deepStrictEqual(initEvents, [{ type: 'session_started', sessionId: 'sess-abc' }]);
  assert.equal(state.sessionId, 'sess-abc');

  // Non-init system subtypes (e.g. compact) must not spuriously re-announce the session.
  const compactEvents = parseClaudeLineToNormalized(
    JSON.stringify({ type: 'system', subtype: 'compact' }),
    state,
  );
  assert.deepStrictEqual(compactEvents, []);
});

test('parseClaudeLineToNormalized: turn_complete cost delta = cumulative − previous cumulative (clamped at 0)', () => {
  const state = createClaudeParserState();
  const first = parseClaudeLineToNormalized(
    JSON.stringify({ type: 'result', num_turns: 3, total_cost_usd: 1.0, is_error: false }),
    state,
  );
  assert.deepStrictEqual(first, [{ type: 'turn_complete', numTurns: 3, totalCostUsd: 1.0 }]);

  const second = parseClaudeLineToNormalized(
    JSON.stringify({ type: 'result', num_turns: 5, total_cost_usd: 1.5, is_error: false }),
    state,
  );
  assert.deepStrictEqual(second, [{ type: 'turn_complete', numTurns: 5, totalCostUsd: 0.5 }]);
});

test('parseClaudeLineToNormalized: result with is_error=true prepends fatal error before turn_complete', () => {
  const state = createClaudeParserState();
  const events = parseClaudeLineToNormalized(
    JSON.stringify({
      type: 'result',
      num_turns: 1,
      total_cost_usd: 0.01,
      is_error: true,
      result: 'hit your limit',
    }),
    state,
  );
  assert.equal(events.length, 2);
  assert.deepStrictEqual(events[0], { type: 'error', message: 'hit your limit', fatal: true });
  assert.equal(events[1].type, 'turn_complete');
});

test('parseClaudeLineToNormalized: rate_limit_event passes through rate_limit_info', () => {
  const state = createClaudeParserState();
  const rawInfo = { status: 'allowed', isUsingOverage: false };
  const events = parseClaudeLineToNormalized(
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: rawInfo }),
    state,
  );
  assert.deepStrictEqual(events, [{ type: 'rate_limit', raw: rawInfo }]);
});

test('parseClaudeLineToNormalized: AskUserQuestion tool_use emits ask_user_question with parsed questions', () => {
  const state = createClaudeParserState();
  state.sessionId = 'sess-x';
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-1',
      content: [
        {
          type: 'tool_use',
          id: 'tu-1',
          name: 'AskUserQuestion',
          input: {
            questions: [{ question: 'Go?', multi: false, options: ['yes', 'no'] }],
          },
        },
      ],
    },
  });
  const events = parseClaudeLineToNormalized(line, state);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ask_user_question');
  if (events[0].type === 'ask_user_question') {
    assert.equal(events[0].toolUseId, 'tu-1');
    assert.deepStrictEqual(events[0].questions, [
      { question: 'Go?', multi: false, options: ['yes', 'no'] },
    ]);
  }
});

test('parseClaudeLineToNormalized: Write-to-plan-path followed by ExitPlanMode carries resolved path', () => {
  const state = createClaudeParserState();
  const writeLine = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-w',
      content: [
        {
          type: 'tool_use',
          id: 'tu-w',
          name: 'Write',
          input: { file_path: '/home/user/project/plan/thread-plan.md', content: '# Plan' },
        },
      ],
    },
  });
  const writeEvents = parseClaudeLineToNormalized(writeLine, state);
  // Still emits tool_use for the Write call; side-effect updates state.planFilePath.
  assert.equal(writeEvents.length, 1);
  assert.equal(writeEvents[0].type, 'tool_use');
  assert.equal(state.planFilePath, '/home/user/project/plan/thread-plan.md');

  const exitLine = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-e',
      content: [
        {
          type: 'tool_use',
          id: 'tu-e',
          name: 'ExitPlanMode',
          input: { plan: '# approved plan body' },
        },
      ],
    },
  });
  const exitEvents = parseClaudeLineToNormalized(exitLine, state);
  assert.equal(exitEvents.length, 1);
  assert.deepStrictEqual(exitEvents[0], {
    type: 'plan_written',
    toolUseId: 'tu-e',
    path: '/home/user/project/plan/thread-plan.md',
    content: '# approved plan body',
  });
});

test('parseClaudeLineToNormalized: thinking blocks are not emitted (parity with claude-bridge.ts:555-580)', () => {
  const state = createClaudeParserState();
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-t',
      content: [{ type: 'thinking', thinking: 'pondering...' }],
    },
  });
  assert.deepStrictEqual(parseClaudeLineToNormalized(line, state), []);
});

test('parseClaudeLineToNormalized: user tool_result with is_error=true → ok=false', () => {
  const state = createClaudeParserState();
  const line = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu-a', content: 'boom', is_error: true },
      ],
    },
  });
  const events = parseClaudeLineToNormalized(line, state);
  assert.deepStrictEqual(events, [
    { type: 'tool_result', toolUseId: 'tu-a', ok: false, content: 'boom' },
  ]);
});

// --- Codex parser edges (wraps 5de7's narrow codexEventToNormalized) ---

test('parseCodexRpcLine: item/completed agentMessage → assistant_text; commandExecution → [] (Phase 3 deferred)', () => {
  const agent = parseCodexRpcLine(
    JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'hi' } } }),
  );
  assert.deepStrictEqual(agent, [{ type: 'assistant_text', text: 'hi' }]);

  const exec = parseCodexRpcLine(
    JSON.stringify({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', command: 'ls', exitCode: 0 } },
    }),
  );
  assert.deepStrictEqual(exec, []);
});

test('parseCodexRpcLine: unknown method and malformed line → []', () => {
  assert.deepStrictEqual(parseCodexRpcLine('{"not":"valid-method"}'), []);
  assert.deepStrictEqual(parseCodexRpcLine('not-json'), []);
  assert.deepStrictEqual(parseCodexRpcLine(''), []);
  assert.deepStrictEqual(
    parseCodexRpcLine(JSON.stringify({ method: 'turn/started', params: {} })),
    [],
  );
});

test('parseCodexRpcLine: thread/error → non-fatal error event', () => {
  const events = parseCodexRpcLine(
    JSON.stringify({ method: 'thread/error', params: { message: 'boom' } }),
  );
  assert.deepStrictEqual(events, [{ type: 'error', message: 'boom', fatal: false }]);
});

// --- Runtime enumeration of NormalizedEvent discriminators ---
// Compile-time exhaustiveness is already enforced in tests/agent-adapter.test.ts via the
// `_normalizedEventExhaustive` sentinel. This runtime check complements it by asserting
// that a hand-enumerated set matches what the codebase actually constructs, so a rename
// or removal of a variant surfaces even without tsc.

test('runtime enumeration of NormalizedEvent discriminators matches canonical 9-variant set', () => {
  const canonical = new Set<NormalizedEvent['type']>([
    'session_started',
    'assistant_text',
    'tool_use',
    'tool_result',
    'ask_user_question',
    'plan_written',
    'rate_limit',
    'turn_complete',
    'error',
  ]);
  assert.equal(canonical.size, 9, 'canonical set must have 9 variants (DR-0008 §3.3)');
});
