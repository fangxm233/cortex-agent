// input:  backgrounded-subagent lines arriving with no turn open, while a run holds
// output: orphan-subagent routing and background-run-stream delivery specs
// pos:    Claude print backgrounded-subagent trace-continuity tests (engine-owned background phase)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { BgTaskTracker, routeLine } from '../../src/agent-adapter/claude/bg-task-tracker.js';
import { openClaudeTestEngine, collectRun, tick } from './replay-harness.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';

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

const TASK_UPDATED_DONE = JSON.stringify({
  type: 'system', subtype: 'task_updated', task_id: 'a25248b17e8a0b69d',
  patch: { status: 'completed', end_time: 1788744452630 },
});
const TASK_UPDATED_KILLED = JSON.stringify({
  type: 'system', subtype: 'task_updated', task_id: 'a25248b17e8a0b69d',
  patch: { status: 'killed' },
});
const BASH_TASK_STARTED = JSON.stringify({
  type: 'system', subtype: 'task_started', task_id: 'bhyarwdtr',
  tool_use_id: 'toolu_bash01', description: 'run tests', is_backgrounded: true, task_type: 'local_bash',
});
const BASH_TASK_UPDATED_DONE = JSON.stringify({
  type: 'system', subtype: 'task_updated', task_id: 'bhyarwdtr', patch: { status: 'completed' },
});
const FOREGROUND_RESULT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  num_turns: 1, total_cost_usd: 0.1, session_id: 'test-session',
});

/**
 * Open one held run (the parent turn leaves the backgrounded subagent pending on its result) and
 * hand back the session so a test can feed the orphan lines that arrive after that turn closed.
 * The run is what installs the background-phase sink; without it the orphan route has no home.
 */
async function orphanRun(t: { onTestFinished: (fn: () => void) => void }) {
  const { engine, session, close } = openClaudeTestEngine();
  t.onTestFinished(close);
  const run = engine.run({ text: 'go' }, { awaitBackground: 'hold' });
  const { events, done } = collectRun(run);
  session.handleLine(TASK_STARTED);
  session.handleLine(FOREGROUND_RESULT);
  await tick(); // the parent result settles and the phase starts before orphan lines arrive
  return { engine, session, run, events, done };
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

test('run: a backgrounded subagent tool call after the turn closed reaches the background stream', async (t) => {
  const { session, run, events, done } = await orphanRun(t);

  session.handleLine(SUB_TOOL_USE);
  await tick();

  const tools = events.filter((e): e is Extract<RunEvent, { type: 'tool_use' }> => e.type === 'tool_use');
  assert.equal(tools.length, 1, 'tool call delivered');
  assert.equal(tools[0].phase, 'background');
  assert.equal(tools[0].name, 'Read');
  assert.equal(tools[0].toolUseId, 'toolu_child01');
  assert.equal(tools[0].subagent?.parentToolUseId, PARENT, 'carries subagent attribution');
  assert.equal(tools[0].subagent?.type, 'Explore');
  assert.equal(session.currentTurn, null, 'no continuation turn was opened');
  run.cancel();
  await done;
});

test('run: a backgrounded subagent tool result after the turn closed reaches the background stream', async (t) => {
  const { session, run, events, done } = await orphanRun(t);

  session.handleLine(SUB_TOOL_RESULT);
  await tick();

  const results = events.filter((e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  assert.equal(results.length, 1, 'tool result delivered');
  assert.equal(results[0].phase, 'background');
  assert.equal(results[0].toolUseId, 'toolu_child01');
  assert.equal(results[0].content, 'file body');
  assert.equal(results[0].subagent?.parentToolUseId, PARENT);
  assert.equal(session.currentTurn, null, 'no continuation turn was opened');
  run.cancel();
  await done;
});

test("run: a backgrounded subagent's final report reaches the background stream as attributed text", async (t) => {
  const { session, run, events, done } = await orphanRun(t);

  session.handleLine(SUB_FINAL_TEXT);
  await tick();

  const texts = events.filter((e): e is Extract<RunEvent, { type: 'assistant_text' }> => e.type === 'assistant_text');
  assert.equal(texts.length, 1, 'final report delivered');
  assert.equal(texts[0].text, '## Report');
  assert.equal(texts[0].phase, 'background');
  assert.equal(texts[0].subagent?.parentToolUseId, PARENT, 'attributed, so it cannot read as the answer');
  assert.equal(session.currentTurn, null, 'no continuation turn was opened');
  run.cancel();
  await done;
});

test('run: orphan subagent lines do not consume the armed continuation', async (t) => {
  const { session, run, events, done } = await orphanRun(t);

  session.handleLine(TASK_NOTIFICATION);
  session.handleLine(SUB_FINAL_TEXT);     // subagent speaks first — must not become the continuation turn
  await tick();
  assert.equal(session.currentTurn, null, 'subagent line did not open the continuation turn');

  session.handleLine(MAIN_ASSISTANT);     // the main agent's re-invocation still opens it
  await tick();
  assert.ok(session.currentTurn, 'main-agent line opened the continuation turn');
  const subText = events.find((e): e is Extract<RunEvent, { type: 'assistant_text' }> =>
    e.type === 'assistant_text' && e.subagent !== undefined);
  assert.equal(subText?.text, '## Report', 'subagent text stayed attributed');
  assert.equal(subText?.subagent?.parentToolUseId, PARENT);
  const mainText = events.find((e): e is Extract<RunEvent, { type: 'assistant_text' }> =>
    e.type === 'assistant_text' && e.subagent === undefined);
  assert.equal(mainText?.phase, 'background');
  assert.equal(mainText?.text, 'the agent finished');

  run.cancel();
  await done;
});

test('subagentEndFor: task_started linkage turns a task_updated into a parent-keyed end signal', () => {
  const tracker = new BgTaskTracker();
  tracker.observe(JSON.parse(TASK_STARTED));

  const end = tracker.subagentEndFor(JSON.parse(TASK_UPDATED_DONE));
  assert.deepEqual(end, { parentToolUseId: PARENT, status: 'completed' });

  // Consuming: the notification that follows the same task must not report the end twice.
  assert.equal(tracker.subagentEndFor(JSON.parse(TASK_NOTIFICATION)), null, 'reported exactly once');
});

test('subagentEndFor: a killed subagent still produces an end signal', () => {
  const tracker = new BgTaskTracker();
  tracker.observe(JSON.parse(TASK_STARTED));
  // TaskStop kills are the case with no notification and possibly no further main-agent line —
  // without this signal the UI block would spin forever.
  assert.deepEqual(
    tracker.subagentEndFor(JSON.parse(TASK_UPDATED_KILLED)),
    { parentToolUseId: PARENT, status: 'killed' },
  );
});

test('subagentEndFor: a backgrounded Bash task is not a subagent', () => {
  const tracker = new BgTaskTracker();
  tracker.observe(JSON.parse(BASH_TASK_STARTED));
  assert.equal(tracker.subagentEndFor(JSON.parse(BASH_TASK_UPDATED_DONE)), null);
});

test('subagentEndFor: an unknown task (no task_started seen, e.g. after resume) reports nothing', () => {
  const tracker = new BgTaskTracker();
  assert.equal(tracker.subagentEndFor(JSON.parse(TASK_UPDATED_DONE)), null);
});

test('run: subagent completion reaches the background stream keyed by its spawning tool call', async (t) => {
  const { session, run, events, done } = await orphanRun(t);

  session.handleLine(SUB_TOOL_USE);
  await tick();
  assert.equal(events.filter((e) => e.type === 'subagent_end').length, 0, 'still running');

  session.handleLine(TASK_UPDATED_DONE);
  await tick();

  const ends = events.filter((e): e is Extract<RunEvent, { type: 'subagent_end' }> => e.type === 'subagent_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].phase, 'background');
  assert.equal(ends[0].parentToolUseId, PARENT);
  assert.equal(ends[0].status, 'completed');
  run.cancel();
  await done;
});

test('run: a killed subagent is sealed without any main-agent line', async (t) => {
  const { session, run, events, done } = await orphanRun(t);

  session.handleLine(TASK_UPDATED_KILLED);
  await tick();

  const ends = events.filter((e): e is Extract<RunEvent, { type: 'subagent_end' }> => e.type === 'subagent_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].phase, 'background');
  assert.equal(ends[0].parentToolUseId, PARENT);
  assert.equal(ends[0].status, 'killed');
  assert.equal(session.currentTurn, null, 'no turn was opened to carry it');
  run.cancel();
  await done;
});
