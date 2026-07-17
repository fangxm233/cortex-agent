// input:  piRpcLineToNormalized + createPIEventParserState
// output: PI event parser unit tests (9 variants + edge cases)
// pos:    PI rpc → NormalizedEvent translator full coverage
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  piRpcLineToNormalized,
  createPIEventParserState,
  type PIEventParserState,
} from '../src/agent-adapter/pi/event-parser.js';

function freshState(): PIEventParserState {
  return createPIEventParserState();
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// 1. session_started — bootstrap response
// ---------------------------------------------------------------------------

test('session_started: bootstrap response with sessionId', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'response', id: 'bootstrap', command: 'get_state', success: true, data: { sessionId: 's-1' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'session_started', sessionId: 's-1' });
  assert.equal(state.sessionId, 's-1');
});

test('session_started: bootstrap dedup — second bootstrap produces []', () => {
  const state = freshState();
  const fixture = line({ type: 'response', id: 'bootstrap', command: 'get_state', success: true, data: { sessionId: 's-1' } });
  piRpcLineToNormalized(fixture, state); // first — sets state.sessionId
  const second = piRpcLineToNormalized(fixture, state);
  assert.deepEqual(second, []);
  assert.equal(state.sessionId, 's-1'); // unchanged
});

test('session_started: bootstrap without sessionId → []', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'response', id: 'bootstrap', command: 'get_state', success: true, data: {} }),
    state,
  );
  assert.deepEqual(events, []);
  assert.equal(state.sessionId, null);
});

test('session_started: bootstrap with empty sessionId string → []', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'response', id: 'bootstrap', command: 'get_state', success: true, data: { sessionId: '' } }),
    state,
  );
  assert.deepEqual(events, []);
});

test('session_started: bootstrap response with sessionFile', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'response', id: 'bootstrap', command: 'get_state', success: true, data: { sessionId: 's-1', sessionFile: '/tmp/sessions-pi/2026-04-30_s-1.jsonl' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'session_started', sessionId: 's-1', sessionFile: '/tmp/sessions-pi/2026-04-30_s-1.jsonl' });
  assert.equal(state.sessionId, 's-1');
});

test('session_started: bootstrap dedup preserves sessionFile', () => {
  const state = freshState();
  const fixture = line({ type: 'response', id: 'bootstrap', command: 'get_state', success: true, data: { sessionId: 's-1', sessionFile: '/tmp/s.jsonl' } });
  piRpcLineToNormalized(fixture, state);
  const second = piRpcLineToNormalized(fixture, state);
  assert.deepEqual(second, []);
  assert.equal(state.sessionId, 's-1');
});

// ---------------------------------------------------------------------------
// 2. assistant_text — message_update text_delta
// ---------------------------------------------------------------------------

test('assistant_text: message_update text_delta with blockId', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'message_update', message: { id: 'm1' }, assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }),
    state,
  );
  assert.equal(events.length, 1);
  const evt = events[0] as any;
  assert.equal(evt.type, 'assistant_text');
  assert.equal(evt.text, 'hello');
  assert.equal(evt.blockId, 'm1');
});

test('assistant_text: message_update without blockId', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).blockId, undefined);
});

test('assistant_text: message_update non-text_delta type → []', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'message_update', assistantMessageEvent: { type: 'input_json_delta', delta: '{}' } }),
    state,
  );
  assert.deepEqual(events, []);
});

test('assistant_text: message_update empty delta → []', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } }),
    state,
  );
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// 3. tool_use — tool_execution_start (regular tools)
// ---------------------------------------------------------------------------

test('tool_use: tool_execution_start regular tool (bash)', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'ls' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'tool_use', toolUseId: 'tc1', name: 'bash', input: { command: 'ls' } });
});

test('tool_use: tool_execution_start with canonical name mapping', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'read', args: { file_path: '/tmp/x' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).name, 'read');
});

test('tool_use: tool_execution_start missing toolCallId → []', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolName: 'bash', args: {} }),
    state,
  );
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// 4. tool_result — tool_execution_end
// ---------------------------------------------------------------------------

test('tool_result: tool_execution_end success with array content', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'tool_result', toolUseId: 'tc1', ok: true, content: 'ok' });
});

test('tool_result: tool_execution_end error', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_end', toolCallId: 'tc1', isError: true, result: { content: [{ type: 'text', text: 'fail' }] } }),
    state,
  );
  assert.deepEqual(events[0], { type: 'tool_result', toolUseId: 'tc1', ok: false, content: 'fail' });
});

test('tool_result: array content joining (multiple text blocks)', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] } }),
    state,
  );
  assert.equal((events[0] as any).content, 'hello world');
});

test('tool_result: non-text blocks in array are skipped', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'result' }] } }),
    state,
  );
  assert.equal((events[0] as any).content, 'result');
});

test('tool_result: string content', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: 'direct string' } }),
    state,
  );
  assert.equal((events[0] as any).content, 'direct string');
});

test('tool_result: missing toolCallId → []', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_end', isError: false, result: {} }),
    state,
  );
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// 5. ask_user_question — tool shim path
// ---------------------------------------------------------------------------
// DR-0008 §5.6: tool_execution_start toolName='ask_user_question' now emits tool_use
// (not ask_user_question) to avoid duplicating the ask_user_question NormalizedEvent that
// extension_ui_request will emit when the shim calls ctx.ui.select/input. The canonical
// ask_user_question NormalizedEvent comes exclusively from the extension_ui_request path (§5b).

test('ask_user_question (tool shim): tool_execution_start → tool_use (not ask_user_question)', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'ask_user_question', args: { questions: [{ question: 'Go?' }] } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: 'tool_use',
    toolUseId: 'tc2',
    name: 'ask_user_question',
    input: { questions: [{ question: 'Go?' }] },
  });
});

test('ask_user_question (tool shim): tool_execution_start with options/multi → tool_use', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc3', toolName: 'ask_user_question', args: { questions: [{ question: 'Pick?', options: ['A', 'B'], multi: true }] } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_use');
  assert.equal((events[0] as any).name, 'ask_user_question');
  assert.deepEqual((events[0] as any).input.questions[0], { question: 'Pick?', options: ['A', 'B'], multi: true });
});

test('ask_user_question (tool shim): tool_execution_start with non-array questions → tool_use (input preserved)', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc4', toolName: 'ask_user_question', args: { questions: 'not an array' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_use');
  assert.equal((events[0] as any).name, 'ask_user_question');
});

// ---------------------------------------------------------------------------
// 5b. ask_user_question — extension_ui_request path
// ---------------------------------------------------------------------------

test('ask_user_question (extension_ui): select method', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Allow?', options: ['Yes', 'No'] }),
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
  const events = piRpcLineToNormalized(
    line({ type: 'extension_ui_request', id: 'u2', method: 'confirm', title: 'Are you sure?', message: 'This will delete data' }),
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
  const events = piRpcLineToNormalized(
    line({ type: 'extension_ui_request', id: 'u3', method: 'input', title: 'Enter name' }),
    state,
  );
  const evt = events[0] as any;
  assert.equal(evt.questions[0].question, 'Enter name');
  assert.equal(evt.questions[0].options, undefined);
});

test('ask_user_question (extension_ui): editor method sets multi=true', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'extension_ui_request', id: 'u4', method: 'editor', title: 'Write note' }),
    state,
  );
  assert.equal((events[0] as any).questions[0].multi, true);
});

test('extension_ui_request fire-and-forget methods → []', () => {
  const state = freshState();
  for (const method of ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']) {
    const events = piRpcLineToNormalized(
      line({ type: 'extension_ui_request', id: 'u5', method, title: 'irrelevant' }),
      state,
    );
    assert.deepEqual(events, [], `expected [] for method=${method}`);
  }
});

test('extension_ui_request: missing id or method → []', () => {
  const state = freshState();
  assert.deepEqual(piRpcLineToNormalized(line({ type: 'extension_ui_request', method: 'select', title: 'T' }), state), []);
  assert.deepEqual(piRpcLineToNormalized(line({ type: 'extension_ui_request', id: 'u1', title: 'T' }), state), []);
});

// ---------------------------------------------------------------------------
// 6. plan_written — Write to plan path + exit_plan_mode
// ---------------------------------------------------------------------------

test('plan_written: Write to plan path sets pendingPlanPath, exit_plan_mode emits tool_use + plan_written', () => {
  const state = freshState();
  // Step 1: Write to a plan path (.claude/plan/ qualifies per DEFAULT_PLAN_DIRS)
  const writeEvents = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc-write', toolName: 'Write', args: { file_path: '/home/user/project/.claude/plan/task-a7f9.md' } }),
    state,
  );
  // Write emits tool_use and sets pendingPlanPath
  assert.equal(writeEvents.length, 1);
  assert.equal(writeEvents[0]?.type, 'tool_use');
  assert.equal(state.pendingPlanPath, '/home/user/project/.claude/plan/task-a7f9.md');
  // Step 2: exit_plan_mode emits tool_use + plan_written (when pendingPlanPath is set)
  const exitEvents = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc3', toolName: 'exit_plan_mode', args: { plan: '# Plan\nStep 1' } }),
    state,
  );
  assert.equal(exitEvents.length, 2);
  assert.equal(exitEvents[0].type, 'tool_use');
  const evt = exitEvents[1] as any;
  assert.equal(evt.type, 'plan_written');
  assert.equal(evt.toolUseId, 'tc3');
  assert.equal(evt.path, '/home/user/project/.claude/plan/task-a7f9.md');
  assert.equal(evt.content, '# Plan\nStep 1');
});

test('plan_written: exit_plan_mode before any Write (pendingPlanPath=null) → tool_use only', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc3', toolName: 'exit_plan_mode', args: { plan: '# Plan' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_use');
});

test('plan_written: Write to non-plan path does not set pendingPlanPath', () => {
  const state = freshState();
  piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tw1', toolName: 'Write', args: { file_path: '/tmp/random.txt' } }),
    state,
  );
  assert.equal(state.pendingPlanPath, null);
  // exit_plan_mode with null pendingPlanPath → tool_use only (no plan_written)
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc3', toolName: 'exit_plan_mode', args: { plan: '# Plan' } }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_use');
});

test('plan_written: lowercase write toolName also sets pendingPlanPath', () => {
  const state = freshState();
  piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tw1', toolName: 'write', args: { file_path: '/home/user/project/plan/task-a7f9.md' } }),
    state,
  );
  assert.notEqual(state.pendingPlanPath, null);
});

test('plan_written: content falls back to args.content if args.plan missing', () => {
  const state = freshState();
  // Set up plan path
  piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tw1', toolName: 'Write', args: { file_path: '/home/user/project/.claude/plan/fallback-plan.md' } }),
    state,
  );
  const events = piRpcLineToNormalized(
    line({ type: 'tool_execution_start', toolCallId: 'tc4', toolName: 'exit_plan_mode', args: { content: '# Alt plan' } }),
    state,
  );
  // exit_plan_mode emits tool_use (idx 0) + plan_written (idx 1) when pendingPlanPath is set
  assert.equal(events.length, 2);
  assert.equal((events[1] as any).content, '# Alt plan');
});

// ---------------------------------------------------------------------------
// 7. rate_limit — auto_retry_start
// ---------------------------------------------------------------------------

test('rate_limit: auto_retry_start', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'auto_retry_start', attempt: 1, errorMessage: '529 overloaded' }),
    state,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'rate_limit');
  assert.ok((events[0] as any).raw);
});

// ---------------------------------------------------------------------------
// 8. turn_complete — agent_end
// ---------------------------------------------------------------------------

test('turn_complete: agent_end with cost data', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [{ role: 'assistant', usage: { cost: { total: 0.05 } } }] }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.05 });
});

test('turn_complete: agent_end multiple assistant messages sums cost', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [
      { role: 'assistant', usage: { cost: { total: 0.03 } } },
      { role: 'user' },
      { role: 'assistant', usage: { cost: { total: 0.02 } } },
    ] }),
    state,
  );
  const evt = events[0] as any;
  assert.equal(evt.numTurns, 2);
  assert.ok(Math.abs(evt.totalCostUsd - 0.05) < 1e-10);
});

test('turn_complete: agent_end no cost data → totalCostUsd: null', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [{ role: 'assistant' }] }),
    state,
  );
  assert.equal((events[0] as any).totalCostUsd, null);
});

test('turn_complete: agent_end empty messages', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [] }),
    state,
  );
  assert.deepEqual(events[0], { type: 'turn_complete', numTurns: 0, totalCostUsd: null });
});

test('turn_complete: agent_end no messages field', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end' }),
    state,
  );
  assert.deepEqual(events[0], { type: 'turn_complete', numTurns: 0, totalCostUsd: null });
});

test('turn_complete: assistant stopReason "error" surfaces errorMessage on turn_complete', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [
      { role: 'assistant', provider: 'deepseek', model: 'deepseek-v4-flash', stopReason: 'error', errorMessage: '400 Unknown mode: deepseek' },
    ] }),
    state,
  );
  const tc = events.find((e) => e.type === 'turn_complete') as any;
  assert.ok(tc, 'turn_complete emitted');
  assert.equal(tc.error, '400 Unknown mode: deepseek');
});

test('turn_complete: stopReason "error" without errorMessage falls back to generic message', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }] }),
    state,
  );
  const tc = events.find((e) => e.type === 'turn_complete') as any;
  assert.equal(tc.error, 'PI agent reported an error during execution');
});

test('turn_complete: successful turn has no error field', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [{ role: 'assistant', usage: { cost: { total: 0.01 } } }] }),
    state,
  );
  assert.deepEqual(events[0], { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.01 });
});

// ---------------------------------------------------------------------------
// 8b. cost_record — agent_end with provider/model (task 1e0b)
// ---------------------------------------------------------------------------
// cost_record is emitted BEFORE turn_complete when the first assistant message has a non-empty
// provider field. Existing tests (§8) use messages without provider, so they remain length===1.

test('cost_record: agent_end with provider+model+usage → [cost_record, turn_complete]', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [
      { role: 'assistant', provider: 'anthropic', model: 'claude-opus-4', usage: { input: 100, output: 50, cost: { total: 0.001 } } },
    ] }),
    state,
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { type: 'cost_record', provider: 'anthropic', model: 'claude-opus-4', tokens_in: 100, tokens_out: 50, cost_usd: 0.001 });
  assert.deepEqual(events[1], { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.001 });
});

test('cost_record: agent_end multiple assistant messages — tokens summed, first provider/model wins', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [
      { role: 'assistant', provider: 'anthropic', model: 'claude-opus-4', usage: { input: 200, output: 80, cost: { total: 0.003 } } },
      { role: 'user' },
      { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4', usage: { input: 150, output: 60, cost: { total: 0.002 } } },
    ] }),
    state,
  );
  assert.equal(events.length, 2);
  const cr = events[0] as any;
  assert.equal(cr.type, 'cost_record');
  assert.equal(cr.provider, 'anthropic');
  assert.equal(cr.model, 'claude-opus-4', 'first assistant model wins');
  assert.equal(cr.tokens_in, 350, 'tokens_in summed: 200+150');
  assert.equal(cr.tokens_out, 140, 'tokens_out summed: 80+60');
  assert.ok(Math.abs(cr.cost_usd - 0.005) < 1e-10);
  const tc = events[1] as any;
  assert.equal(tc.type, 'turn_complete');
  assert.equal(tc.numTurns, 2);
  assert.ok(Math.abs(tc.totalCostUsd - 0.005) < 1e-10);
});

test('cost_record: agent_end without provider → no cost_record, only turn_complete', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [{ role: 'assistant', usage: { cost: { total: 0.05 } } }] }),
    state,
  );
  assert.equal(events.length, 1, 'no cost_record when provider absent');
  assert.equal(events[0]?.type, 'turn_complete');
});

test('cost_record: agent_end with empty string provider → no cost_record', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [{ role: 'assistant', provider: '', model: 'some-model', usage: { input: 10, output: 5, cost: { total: 0.001 } } }] }),
    state,
  );
  assert.equal(events.length, 1, 'empty provider string treated as absent');
  assert.equal(events[0]?.type, 'turn_complete');
});

test('cost_record: agent_end with provider but no usage.input/output → tokens_in/tokens_out: 0', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'agent_end', messages: [{ role: 'assistant', provider: 'openai', model: 'gpt-4o', usage: { cost: { total: 0.002 } } }] }),
    state,
  );
  assert.equal(events.length, 2);
  const cr = events[0] as any;
  assert.equal(cr.type, 'cost_record');
  assert.equal(cr.tokens_in, 0);
  assert.equal(cr.tokens_out, 0);
  assert.ok(Math.abs(cr.cost_usd - 0.002) < 1e-10);
});

// ---------------------------------------------------------------------------
// 9. error — extension_error and failed response
// ---------------------------------------------------------------------------

test('error: extension_error', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'extension_error', error: 'boom' }),
    state,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'error', message: 'boom', fatal: false });
});

test('error: extension_error missing error field → fallback message', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'extension_error' }),
    state,
  );
  assert.equal((events[0] as any).message, 'extension error');
});

test('error: non-bootstrap failed response', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'response', id: 'cmd-1', command: 'prompt', success: false, error: 'bad request' }),
    state,
  );
  assert.deepEqual(events[0], { type: 'error', message: 'bad request', fatal: false });
});

test('error: failed response without error string → fallback message', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'response', command: 'prompt', success: false }),
    state,
  );
  const msg = (events[0] as any).message as string;
  assert.ok(msg.includes('pi command failed'));
});

// ---------------------------------------------------------------------------
// Edge cases — malformed input and silently dropped events
// ---------------------------------------------------------------------------

test('edge: malformed JSON → []', () => {
  const state = freshState();
  assert.deepEqual(piRpcLineToNormalized('{not json', state), []);
});

test('edge: empty line → []', () => {
  const state = freshState();
  assert.deepEqual(piRpcLineToNormalized('', state), []);
});

test('edge: non-object JSON → []', () => {
  const state = freshState();
  assert.deepEqual(piRpcLineToNormalized('"string"', state), []);
  assert.deepEqual(piRpcLineToNormalized('42', state), []);
  assert.deepEqual(piRpcLineToNormalized('null', state), []);
});

test('edge: missing type field → []', () => {
  const state = freshState();
  assert.deepEqual(piRpcLineToNormalized(line({ id: 'foo' }), state), []);
});

test('edge: unknown event type → []', () => {
  const state = freshState();
  assert.deepEqual(piRpcLineToNormalized(line({ type: 'queue_update', data: {} }), state), []);
  assert.deepEqual(piRpcLineToNormalized(line({ type: 'turn_start' }), state), []);
  assert.deepEqual(piRpcLineToNormalized(line({ type: 'compaction_end', reason: 'threshold' }), state), []);
  assert.deepEqual(piRpcLineToNormalized(line({ type: 'auto_retry_end' }), state), []);
  assert.deepEqual(piRpcLineToNormalized(line({ type: 'agent_start' }), state), []);
});

// ---------------------------------------------------------------------------
// context_compacted — compaction_start (compaction_end stays dropped)
// ---------------------------------------------------------------------------

test('context_compacted: compaction_start carries reason as trigger', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(line({ type: 'compaction_start', reason: 'threshold' }), state);
  assert.deepEqual(events, [{ type: 'context_compacted', trigger: 'threshold' }]);
});

test('context_compacted: compaction_start without reason defaults to auto', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(line({ type: 'compaction_start' }), state);
  assert.deepEqual(events, [{ type: 'context_compacted', trigger: 'auto' }]);
});

test('edge: successful non-bootstrap response → []', () => {
  const state = freshState();
  const events = piRpcLineToNormalized(
    line({ type: 'response', id: 'cmd-2', command: 'prompt', success: true }),
    state,
  );
  assert.deepEqual(events, []);
});
