// input:  PI session events and parser state
// output: Tool, dialog, lifecycle, and usage event regressions
// pos:    Tests PI event translation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  piEventToNormalized,
  piContextUsageFromStats,
  createPIEventParserState,
  type PIEventParserState,
} from '../src/agent-adapter/pi/event-parser.js';

function freshState(): PIEventParserState {
  return createPIEventParserState();
}

/** One event as PI's AgentSession delivers it (typed loosely so fixtures can be partial). */
function ev(obj: Record<string, unknown>): Record<string, unknown> {
  return obj;
}

// ---------------------------------------------------------------------------
// 1. context usage — read straight off AgentSession.getSessionStats()
// ---------------------------------------------------------------------------

test('context_usage: session stats map the PI estimate', () => {
  assert.deepEqual(
    piContextUsageFromStats({ contextUsage: { tokens: 425353, contextWindow: 1000000, percent: 42.5353 } }),
    { usedTokens: 425353, contextWindow: 1000000, percent: 42.5353, accuracy: 'estimate' },
  );
});

test('context_usage: preserves PI nulls immediately after compaction', () => {
  assert.deepEqual(
    piContextUsageFromStats({ contextUsage: { tokens: null, contextWindow: 272000, percent: null } }),
    { usedTokens: null, contextWindow: 272000, percent: null, accuracy: 'estimate' },
  );
});

test('context_usage: malformed or missing usage yields nothing', () => {
  assert.equal(piContextUsageFromStats({ contextUsage: { tokens: 12, contextWindow: 0, percent: 4 } }), null);
  assert.equal(piContextUsageFromStats({}), null);
  assert.equal(piContextUsageFromStats(undefined), null);
});

// ---------------------------------------------------------------------------
// 2. assistant_text — message_update text_delta
// ---------------------------------------------------------------------------

test('assistant_text: message_update text_delta with blockId', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'message_update', message: { id: 'm1' }, assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }),
    state,
  );
  assert.deepEqual(events, [{ type: 'assistant_text', text: 'hello', blockId: 'm1' }]);
});

test('assistant_text: blockId falls back to message.responseId (the real PI field)', () => {
  // Real PI AssistantMessage has NO `id` — the stable per-message identifier the provider
  // sets once, before any text_delta, is `responseId` (anthropic msg_… / openai chatcmpl_…).
  const state = freshState();
  const events = piEventToNormalized(
    ev({
      type: 'message_update',
      message: { role: 'assistant', responseId: 'msg_abc123', timestamp: 1 },
      assistantMessageEvent: { type: 'text_delta', delta: 'hello', contentIndex: 0 },
    }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).blockId, 'msg_abc123');
});

test('assistant_text: message.id still wins over responseId when both are present', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({
      type: 'message_update',
      message: { id: 'm1', responseId: 'msg_abc123' },
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    }),
    state,
  );
  assert.equal((events[0] as any).blockId, 'm1');
});

test('assistant_text: message_update without blockId', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).blockId, undefined);
});

test('assistant_text: message_update non-text_delta type → []', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'message_update', assistantMessageEvent: { type: 'input_json_delta', delta: '{}' } }),
    state,
  );
  assert.deepEqual(events, []);
});

test('assistant_text: message_update empty delta → []', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } }),
    state,
  );
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// 3. tool_use — tool_execution_start (regular tools)
// ---------------------------------------------------------------------------

test('tool_use: tool_execution_start regular tool (bash)', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'ls' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'tool_use', toolUseId: 'tc1', name: 'bash', input: { command: 'ls' } });
});

test('tool_use: tool_execution_start with canonical name mapping', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'read', args: { file_path: '/tmp/x' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).name, 'read');
});

test('tool_use: tool_execution_start missing toolCallId → []', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_start', toolName: 'bash', args: {} }),
    state,
  );
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// 4. tool_result — tool_execution_end
// ---------------------------------------------------------------------------

test('tool_result: tool_execution_end success with array content', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'tool_result', toolUseId: 'tc1', ok: true, content: 'ok' });
});

test('tool_result: tool_execution_end error', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_end', toolCallId: 'tc1', isError: true, result: { content: [{ type: 'text', text: 'fail' }] } }),
    state,
  );
  assert.deepEqual(events[0], { type: 'tool_result', toolUseId: 'tc1', ok: false, content: 'fail' });
});

test('tool_result: array content joining (multiple text blocks)', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] } }),
    state,
  );
  assert.equal((events[0] as any).content, 'hello world');
});

test('tool_result: non-text blocks in array are skipped', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'result' }] } }),
    state,
  );
  assert.equal((events[0] as any).content, 'result');
});

test('tool_result: string content', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: 'direct string' } }),
    state,
  );
  assert.equal((events[0] as any).content, 'direct string');
});

test('tool_result: missing toolCallId → []', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'tool_execution_end', isError: false, result: {} }),
    state,
  );
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// 5. Shared interaction MCP tools use the ordinary tool event path
// ---------------------------------------------------------------------------

test('shared interaction MCP tool calls preserve their exposed names and input', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({
      type: 'tool_execution_start',
      toolCallId: 'tc2',
      toolName: 'cortex_ask_user',
      args: { questions: [{ question: 'Go?' }] },
    }),
    state,
  );
  assert.deepEqual(events, [{
    type: 'tool_use',
    toolUseId: 'tc2',
    name: 'cortex_ask_user',
    input: { questions: [{ question: 'Go?' }] },
  }]);
});

// ---------------------------------------------------------------------------
// 5b. Generic extension_ui_request dialog path
// ---------------------------------------------------------------------------

test('ask_user_question (extension_ui): select method', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Allow?', options: ['Yes', 'No'] }),
    state,
  );
  assert.equal(events.length, 1);
  const evt = events[0] as any;
  assert.equal(evt.type, 'ask_user_question');
  assert.equal(evt.toolUseId, 'u1');
  assert.deepEqual(evt.questions[0], { question: 'Allow?', options: ['Yes', 'No'] });
});

test('ask_user_question (extension_ui): confirm method synthesizes Yes/No options', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'extension_ui_request', id: 'u2', method: 'confirm', title: 'Are you sure?', message: 'This will delete data' }),
    state,
  );
  const evt = events[0] as any;
  assert.equal(evt.questions[0].options[0], 'Yes');
  assert.equal(evt.questions[0].options[1], 'No');
  assert.ok(evt.questions[0].question.includes('Are you sure?'));
  assert.ok(evt.questions[0].question.includes('This will delete data'));
});

test('ask_user_question (extension_ui): input method', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'extension_ui_request', id: 'u3', method: 'input', title: 'Enter name' }),
    state,
  );
  const evt = events[0] as any;
  assert.equal(evt.questions[0].question, 'Enter name');
  assert.equal(evt.questions[0].options, undefined);
});

test('ask_user_question (extension_ui): editor method sets multi=true', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'extension_ui_request', id: 'u4', method: 'editor', title: 'Write note' }),
    state,
  );
  assert.equal((events[0] as any).questions[0].multi, true);
});

test('extension_ui_request fire-and-forget methods → []', () => {
  const state = freshState();
  for (const method of ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']) {
    const events = piEventToNormalized(
      ev({ type: 'extension_ui_request', id: 'u5', method, title: 'irrelevant' }),
      state,
    );
    assert.deepEqual(events, [], `expected [] for method=${method}`);
  }
});

test('extension_ui_request: missing id or method → []', () => {
  const state = freshState();
  assert.deepEqual(piEventToNormalized(ev({ type: 'extension_ui_request', method: 'select', title: 'T' }), state), []);
  assert.deepEqual(piEventToNormalized(ev({ type: 'extension_ui_request', id: 'u1', title: 'T' }), state), []);
});

// ---------------------------------------------------------------------------
// 6. PI internal retry lifecycle — never a terminal Cortex event
// ---------------------------------------------------------------------------

test('auto_retry_start and auto_retry_end are non-terminal lifecycle events', () => {
  const state = freshState();
  assert.deepEqual(
    piEventToNormalized(ev({
      type: 'auto_retry_start',
      attempt: 1,
      errorMessage: 'Codex error: Our servers are currently overloaded.',
    }), state),
    [],
  );
  assert.deepEqual(
    piEventToNormalized(ev({ type: 'auto_retry_end', success: true, attempt: 1 }), state),
    [],
  );
});

// ---------------------------------------------------------------------------
// 8. turn_complete — agent_settled after low-level agent_end
// ---------------------------------------------------------------------------

function agentEndThenSettle(
  state: PIEventParserState,
  agentEnd: Record<string, unknown>,
) {
  return [
    ...piEventToNormalized(ev(agentEnd), state),
    ...piEventToNormalized(ev({ type: 'agent_settled' }), state),
  ];
}

test('turn_complete: agent_settled carries prior agent_end cost data', () => {
  const state = freshState();
  const events = agentEndThenSettle(state, {
    type: 'agent_end',
    messages: [{ role: 'assistant', usage: { cost: { total: 0.05 } } }],
  });
  assert.deepEqual(events, [{ type: 'turn_complete', numTurns: 1, totalCostUsd: 0.05 }]);
});

test('turn_complete: multiple assistant messages sum cost', () => {
  const state = freshState();
  const events = agentEndThenSettle(state, { type: 'agent_end', messages: [
    { role: 'assistant', usage: { cost: { total: 0.03 } } },
    { role: 'user' },
    { role: 'assistant', usage: { cost: { total: 0.02 } } },
  ] });
  assert.deepEqual(events, [{ type: 'turn_complete', numTurns: 2, totalCostUsd: 0.05 }]);
});

test('turn_complete: no cost data preserves totalCostUsd null', () => {
  const state = freshState();
  const events = agentEndThenSettle(state, {
    type: 'agent_end', messages: [{ role: 'assistant' }],
  });
  assert.deepEqual(events, [{ type: 'turn_complete', numTurns: 1, totalCostUsd: null }]);
});

test('turn_complete: empty or missing messages settle with zero turns', () => {
  for (const agentEnd of [{ type: 'agent_end', messages: [] }, { type: 'agent_end' }]) {
    const events = agentEndThenSettle(freshState(), agentEnd);
    assert.deepEqual(events, [{ type: 'turn_complete', numTurns: 0, totalCostUsd: null }]);
  }
});

test('turn_complete: final assistant error surfaces on agent_settled', () => {
  const state = freshState();
  const events = agentEndThenSettle(state, { type: 'agent_end', messages: [{
    role: 'assistant', provider: 'deepseek', model: 'deepseek-v4-flash',
    stopReason: 'error', errorMessage: '400 Unknown mode: deepseek',
  }] });
  const terminal = events.find((event) => event.type === 'turn_complete');
  assert.deepEqual(terminal, {
    type: 'turn_complete', numTurns: 1, totalCostUsd: null,
    error: '400 Unknown mode: deepseek',
  });
});

test('turn_complete: missing errorMessage uses the generic PI error', () => {
  const events = agentEndThenSettle(freshState(), {
    type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }],
  });
  assert.equal(
    (events[0] as any).error,
    'PI agent reported an error during execution',
  );
});

test('turn_complete: successful turn has no error field', () => {
  const events = agentEndThenSettle(freshState(), {
    type: 'agent_end',
    messages: [{ role: 'assistant', usage: { cost: { total: 0.01 } } }],
  });
  assert.deepEqual(events, [{ type: 'turn_complete', numTurns: 1, totalCostUsd: 0.01 }]);
});

// ---------------------------------------------------------------------------
// 8b. cost_record — emitted per agent_end before one settled terminal
// ---------------------------------------------------------------------------

test('cost_record: provider/model/usage precedes settled turn_complete', () => {
  const events = agentEndThenSettle(freshState(), { type: 'agent_end', messages: [{
    role: 'assistant', provider: 'anthropic', model: 'claude-opus-4',
    usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10,
      cost: { total: 0.001 } },
  }] });
  assert.deepEqual(events, [
    {
      type: 'cost_record', provider: 'anthropic', model: 'claude-opus-4',
      tokens_in: 100, tokens_out: 50, prompt_tokens: 130, cached_tokens: 20,
      input_tokens: 100, output_tokens: 50, cache_read_tokens: 20,
      cache_creation_tokens: 10, provider_requests: 1, cost_usd: 0.001,
    },
    { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.001 },
  ]);
});

test('cost_record: multiple messages sum tokens and use the first identity', () => {
  const events = agentEndThenSettle(freshState(), { type: 'agent_end', messages: [
    { role: 'assistant', provider: 'anthropic', model: 'claude-opus-4', usage: { input: 200, output: 80, cost: { total: 0.003 } } },
    { role: 'user' },
    { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4', usage: { input: 150, output: 60, cost: { total: 0.002 } } },
  ] });
  assert.deepEqual(events[0], {
    type: 'cost_record', provider: 'anthropic', model: 'claude-opus-4',
    tokens_in: 350, tokens_out: 140, prompt_tokens: null, cached_tokens: null,
    input_tokens: 350, output_tokens: 140, cache_read_tokens: null,
    cache_creation_tokens: null, provider_requests: 2, cost_usd: 0.005,
  });
  assert.deepEqual(events[1], { type: 'turn_complete', numTurns: 2, totalCostUsd: 0.005 });
});

test('cost_record: missing or empty provider emits no low-level cost event', () => {
  for (const provider of [undefined, '']) {
    const state = freshState();
    const messages = [{
      role: 'assistant', provider, model: 'some-model',
      usage: { input: 10, output: 5, cost: { total: 0.001 } },
    }];
    assert.deepEqual(
      piEventToNormalized(ev({ type: 'agent_end', messages }), state),
      [],
    );
    assert.equal(piEventToNormalized(ev({ type: 'agent_settled' }), state)[0]?.type, 'turn_complete');
  }
});

test('cost_record: reported zero remains zero while absent token counts remain unavailable', () => {
  const state = freshState();
  const zero = piEventToNormalized(ev({ type: 'agent_end', messages: [{
    role: 'assistant', provider: 'openai', model: 'gpt-4o',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }] }), state);
  assert.deepEqual(zero, [{
    type: 'cost_record', provider: 'openai', model: 'gpt-4o',
    tokens_in: 0, tokens_out: 0, prompt_tokens: 0, cached_tokens: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_creation_tokens: 0, provider_requests: 1, cost_usd: 0,
  }]);

  const unavailable = piEventToNormalized(ev({ type: 'agent_end', messages: [{
    role: 'assistant', provider: 'openai', model: 'gpt-4o',
    usage: { cost: { total: 0.002 } },
  }] }), freshState());
  assert.deepEqual(unavailable, [{
    type: 'cost_record', provider: 'openai', model: 'gpt-4o',
    tokens_in: 0, tokens_out: 0, prompt_tokens: null, cached_tokens: null,
    input_tokens: null, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: null, provider_requests: 1, cost_usd: 0.002,
  }]);
});

// ---------------------------------------------------------------------------
// 9. error — extension_error and failed response
// ---------------------------------------------------------------------------

test('error: extension_error', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'extension_error', error: 'boom' }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'error', message: 'boom', fatal: false });
});

test('error: extension_error missing error field → fallback message', () => {
  const state = freshState();
  const events = piEventToNormalized(
    ev({ type: 'extension_error' }),
    state,
  );
  assert.equal((events[0] as any).message, 'extension error');
});

// ---------------------------------------------------------------------------
// Edge cases — malformed input and silently dropped events
// ---------------------------------------------------------------------------

test('edge: missing type field → []', () => {
  const state = freshState();
  assert.deepEqual(piEventToNormalized(ev({ id: 'foo' }), state), []);
});

test('edge: unknown event type → []', () => {
  const state = freshState();
  assert.deepEqual(piEventToNormalized(ev({ type: 'queue_update', data: {} }), state), []);
  assert.deepEqual(piEventToNormalized(ev({ type: 'turn_start' }), state), []);
  assert.deepEqual(piEventToNormalized(ev({ type: 'compaction_end', reason: 'threshold' }), state), []);
  assert.deepEqual(piEventToNormalized(ev({ type: 'agent_start' }), state), []);
});

// ---------------------------------------------------------------------------
// context_compacted — compaction_start (compaction_end stays dropped)
// ---------------------------------------------------------------------------

test('context_compacted: compaction_start carries reason as trigger', () => {
  const state = freshState();
  const events = piEventToNormalized(ev({ type: 'compaction_start', reason: 'threshold' }), state);
  assert.deepEqual(events, [{ type: 'context_compacted', trigger: 'threshold' }]);
});

test('context_compacted: compaction_start without reason defaults to auto', () => {
  const state = freshState();
  const events = piEventToNormalized(ev({ type: 'compaction_start' }), state);
  assert.deepEqual(events, [{ type: 'context_compacted', trigger: 'auto' }]);
});

test('agent_settled: compaction continuation aggregates runs and resets after settlement', () => {
  const state = freshState();
  const first = piEventToNormalized(ev({
    type: 'agent_end',
    messages: [{
      role: 'assistant', provider: 'openai', model: 'gpt-5.6-sol',
      usage: { input: 100, output: 20, cost: { total: 0.02 } },
    }],
  }), state);
  assert.deepEqual(first.map((event) => event.type), ['cost_record']);

  assert.deepEqual(
    piEventToNormalized(ev({ type: 'compaction_start', reason: 'threshold' }), state),
    [{ type: 'context_compacted', trigger: 'threshold' }],
  );
  assert.deepEqual(piEventToNormalized(ev({ type: 'compaction_end' }), state), []);

  const second = piEventToNormalized(ev({
    type: 'agent_end',
    messages: [{ role: 'assistant', usage: { cost: { total: 0.03 } } }],
  }), state);
  assert.deepEqual(second, []);
  assert.deepEqual(
    piEventToNormalized(ev({ type: 'agent_settled' }), state),
    [{ type: 'turn_complete', numTurns: 2, totalCostUsd: 0.05 }],
  );

  piEventToNormalized(ev({
    type: 'agent_end',
    messages: [{ role: 'assistant', usage: { cost: { total: 0.01 } } }],
  }), state);
  assert.deepEqual(
    piEventToNormalized(ev({ type: 'agent_settled' }), state),
    [{ type: 'turn_complete', numTurns: 1, totalCostUsd: 0.01 }],
  );
});

test('agent_settled: successful retry clears the earlier low-level run error', () => {
  const state = freshState();
  assert.deepEqual(piEventToNormalized(ev({
    type: 'agent_end', willRetry: true,
    messages: [{
      role: 'assistant', stopReason: 'error', errorMessage: 'transient overload',
      usage: { cost: { total: 0.01 } },
    }],
  }), state), []);
  assert.deepEqual(piEventToNormalized(ev({
    type: 'agent_end',
    messages: [{ role: 'assistant', usage: { cost: { total: 0.02 } } }],
  }), state), []);

  assert.deepEqual(
    piEventToNormalized(ev({ type: 'agent_settled' }), state),
    [{ type: 'turn_complete', numTurns: 2, totalCostUsd: 0.03 }],
  );
});
