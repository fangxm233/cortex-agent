// input:  backgrounded-subagent lines arriving with no turn open
// output: orphan-subagent routing and continuation-sink delivery specs
// pos:    Claude print backgrounded-subagent trace-continuity tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../../src/agent-adapter/claude/adapter.js';
import { BgTaskTracker, routeLine } from '../../src/agent-adapter/claude/bg-task-tracker.js';

const FAKE_STREAM = { write() {}, end() {} } as any;
const PARENT = 'toolu_parent01';

const SUB_TOOL_USE = JSON.stringify({
  type: 'assistant',
  parent_tool_use_id: PARENT,
  subagent_type: 'Explore',
  message: {
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', id: 'toolu_child01', name: 'Read', input: { file_path: '/tmp/a.ts' } }],
  },
});
const SUB_TOOL_RESULT = JSON.stringify({
  type: 'user',
  parent_tool_use_id: PARENT,
  subagent_type: 'Explore',
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_child01', content: 'file body' }] },
});
const SUB_FINAL_TEXT = JSON.stringify({
  type: 'assistant',
  parent_tool_use_id: PARENT,
  subagent_type: 'Explore',
  message: { model: 'claude-opus-5', content: [{ type: 'text', text: '## Report' }] },
});
const TASK_STARTED = JSON.stringify({
  type: 'system', subtype: 'task_started', task_id: 'a25248b17e8a0b69d',
  tool_use_id: PARENT, subagent_type: 'Explore', description: 'probe',
});
const TASK_NOTIFICATION = JSON.stringify({
  type: 'system', subtype: 'task_notification', task_id: 'a25248b17e8a0b69d',
  tool_use_id: PARENT, status: 'completed',
});
const MAIN_ASSISTANT = JSON.stringify({
  type: 'assistant',
  message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'the agent finished' }] },
});

interface Captured {
  tools: Array<{ name: string; id: string; sub: any }>;
  texts: Array<{ text: string; sub: any }>;
  results: Array<{ id: string; content: string; sub: any }>;
}

function sessionWithSink(t: { onTestFinished: (fn: () => void) => void }) {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());
  const cap: Captured = { tools: [], texts: [], results: [] };
  s.setContinuationSink({
    onResult() {},
    onAssistantText: (text: string, _model: any, sub: any) => { cap.texts.push({ text, sub }); },
    onToolUse: (name: string, _input: any, id: string, sub: any) => { cap.tools.push({ name, id, sub }); },
    onToolResult: (id: string, content: string, _err: boolean, sub: any) => {
      cap.results.push({ id, content, sub });
    },
  });
  return { s, cap };
}

test('routeLine: a subagent-linked line with no turn open routes to subagent-orphan', () => {
  const tracker = new BgTaskTracker();
  const line = JSON.parse(SUB_TOOL_USE);
  assert.equal(routeLine(tracker, line, false), 'subagent-orphan');
  assert.equal(routeLine(tracker, JSON.parse(SUB_TOOL_RESULT), false), 'subagent-orphan');
  // An active turn still wins: the in-turn path owns attribution and bookkeeping.
  assert.equal(routeLine(tracker, line, true), 'normal');
});

test('routeLine: subagent-orphan wins over open-continuation once a notification armed', () => {
  const tracker = new BgTaskTracker();
  tracker.observe(JSON.parse(TASK_STARTED));
  tracker.observe(JSON.parse(TASK_NOTIFICATION));
  assert.ok(tracker.continuationArmed, 'notification armed a continuation');
  // The subagent's own line must not be mistaken for the main agent being re-invoked.
  assert.equal(routeLine(tracker, JSON.parse(SUB_TOOL_USE), false), 'subagent-orphan');
  // The main agent's line still opens the continuation turn.
  assert.equal(routeLine(tracker, JSON.parse(MAIN_ASSISTANT), false), 'open-continuation');
});

test('handleLine: a backgrounded subagent tool call after the turn closed reaches the sink', (t) => {
  const { s, cap } = sessionWithSink(t);

  s.handleLine(SUB_TOOL_USE);

  assert.equal(cap.tools.length, 1, 'tool call delivered');
  assert.equal(cap.tools[0].name, 'Read');
  assert.equal(cap.tools[0].id, 'toolu_child01');
  assert.equal(cap.tools[0].sub?.parentToolUseId, PARENT, 'carries subagent attribution');
  assert.equal(cap.tools[0].sub?.type, 'Explore');
  assert.equal(s.currentTurn, null, 'no continuation turn was opened');
});

test('handleLine: a backgrounded subagent tool result after the turn closed reaches the sink', (t) => {
  const { s, cap } = sessionWithSink(t);

  s.handleLine(SUB_TOOL_RESULT);

  assert.equal(cap.results.length, 1, 'tool result delivered');
  assert.equal(cap.results[0].id, 'toolu_child01');
  assert.equal(cap.results[0].content, 'file body');
  assert.equal(cap.results[0].sub?.parentToolUseId, PARENT);
  assert.equal(s.currentTurn, null, 'no continuation turn was opened');
});

test("handleLine: a backgrounded subagent's final report reaches the sink as attributed text", (t) => {
  const { s, cap } = sessionWithSink(t);

  s.handleLine(SUB_FINAL_TEXT);

  assert.equal(cap.texts.length, 1, 'final report delivered');
  assert.equal(cap.texts[0].text, '## Report');
  assert.equal(cap.texts[0].sub?.parentToolUseId, PARENT, 'attributed, so it cannot read as the answer');
  assert.equal(s.currentTurn, null, 'no continuation turn was opened');
});

test('handleLine: orphan subagent lines do not consume the armed continuation', (t) => {
  const { s, cap } = sessionWithSink(t);

  s.handleLine(TASK_STARTED);
  s.handleLine(TASK_NOTIFICATION);
  s.handleLine(SUB_FINAL_TEXT);     // subagent speaks first — must not become the continuation turn
  assert.equal(s.currentTurn, null, 'subagent line did not open the continuation turn');

  s.handleLine(MAIN_ASSISTANT);     // the main agent's re-invocation still opens it
  assert.ok(s.currentTurn, 'main-agent line opened the continuation turn');
  assert.equal(cap.texts[0].sub?.parentToolUseId, PARENT, 'subagent text stayed attributed');
});
