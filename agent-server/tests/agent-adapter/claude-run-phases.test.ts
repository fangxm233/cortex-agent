// input:  fixtures/runs/claude-*.jsonl replayed through replay-harness.replayClaudeRun
// output: regression spec for Claude run phases on the EngineRun seam (foreground/background
//         RunEvents, run result + settled, injection and background policy)
// pos:    Run-phase baseline — the behaviour the engine-owned background phase must keep for
//         continuation, injection, orphan subagents and the resume notification turn

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { replayClaudeRun, type ClaudeRunTrace } from './replay-harness.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';

type EventOf<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

/** Every event of one kind, narrowed. */
function eventsOf<T extends RunEvent['type']>(trace: ClaudeRunTrace, type: T): EventOf<T>[] {
  return trace.events.filter((event): event is EventOf<T> => event.type === type);
}

/** The one event of a kind, asserting the run produced it exactly once. */
function one<T extends RunEvent['type']>(trace: ClaudeRunTrace, type: T): EventOf<T> {
  const found = eventsOf(trace, type);
  assert.equal(found.length, 1, `expected exactly one ${type}, got ${found.length}`);
  return found[0];
}

// (a) A background task outliving its user turn: the result reports it as still running, and the
// CLI's later re-invocation of the model is streamed by the engine's background phase.
test('claude run (a): a background task outliving the turn is delivered by a continuation turn', async () => {
  const trace = await replayClaudeRun('claude-bg-continuation', 'hold');

  assert.deepEqual(trace.events.map((event) => event.type), [
    'engine_started',
    'tool_use',
    'turn_progress',
    'cost_record',
    'foreground_result',
    'phase',
    'phase',
    'assistant_text',
    'background_result',
    'phase',
  ]);
  assert.equal(trace.turnError, null);

  const toolUse = one(trace, 'tool_use');
  assert.equal(toolUse.phase, 'foreground');
  assert.equal(toolUse.name, 'Bash');
  assert.equal(toolUse.toolUseId, 'toolu_bg01');
  // The count that makes orchestration hold the status open instead of sealing it.
  const foreground = one(trace, 'foreground_result').result;
  assert.equal(foreground.num_turns, 2);
  assert.equal(foreground.total_cost_usd, 0.25);
  assert.equal(foreground.pendingBackgroundTasks, 1);
  assert.equal(foreground.undeliveredBackgroundTasks, 0);

  // The synthetic continuation turn opens as a second background boundary and speaks on the run's
  // own stream; the terminal phase closes the whole run.
  assert.deepEqual(eventsOf(trace, 'phase'), [
    { type: 'phase', phase: 'background', pendingBackground: 1, undeliveredBackground: 0 },
    { type: 'phase', phase: 'background', pendingBackground: 1, undeliveredBackground: 0 },
    { type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 },
  ]);
  const text = one(trace, 'assistant_text');
  assert.equal(text.phase, 'background');
  assert.equal(text.text, 'Background task done: DONE');
  // Cost is the turn DELTA against the session cursor, not the cumulative total in the line.
  const background = one(trace, 'background_result').result;
  assert.equal(background.num_turns, 1);
  assert.equal(background.total_cost_usd, 0.25);
  assert.equal(background.finalOutput, 'Background task done: DONE');
  assert.equal(background.pendingBackgroundTasks, 0);
  // `result` is the foreground await (hold policy); `settled` is the accumulated whole run.
  assert.equal(trace.result?.total_cost_usd, 0.25);
  assert.equal(trace.settled?.total_cost_usd, 0.5);
  assert.equal(trace.settled?.num_turns, 3);
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, true, true, false, false, true, false]);
});

// (b) The injected message is consumed on a tool-result boundary while the turn is live: it folds
// into that turn (one ack, foldedIntoTurn=true) and no continuation turn is opened.
test('claude run (b): an echo before the result folds the injection into the running turn', async () => {
  const trace = await replayClaudeRun('claude-injection-folded', 'none');

  assert.deepEqual(trace.events.map((event) => event.type), [
    'engine_started',
    'tool_use',
    'turn_progress',
    'tool_result',
    'injection_delivered',
    'assistant_text',
    'turn_progress',
    'cost_record',
    'foreground_result',
    'phase',
  ]);
  assert.equal(trace.turnError, null);

  const delivered = one(trace, 'injection_delivered');
  assert.equal(delivered.foldedIntoTurn, true);
  // The steer's own return carries the id the ack is correlated by.
  assert.deepEqual(trace.steers, [{
    text: 'EARLY-STOP: report what you have', accepted: true, injectionId: delivered.injectionId,
  }]);
  const [toolResult] = eventsOf(trace, 'tool_result');
  assert.equal(toolResult.toolUseId, 'toolu_audit01');
  assert.equal(toolResult.ok, true);
  // The reply belongs to the running turn: one foreground assistant line, no background phase.
  const text = one(trace, 'assistant_text');
  assert.equal(text.phase, 'foreground');
  assert.equal(text.text, 'EARLY-STOP');
  assert.equal(trace.events.some((event) => event.type === 'phase' && event.phase === 'background'), false);
  const foreground = one(trace, 'foreground_result').result;
  assert.equal(foreground.num_turns, 2);
  assert.equal(foreground.total_cost_usd, 0.02);
  assert.equal(foreground.finalOutput, 'EARLY-STOP');
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, true, true, true, true, false]);
});

// (c) The CLI drains the queue only after this turn's result: the echo then acks the injection as a
// NEW turn (foldedIntoTurn=false) and that turn's reply must reach the run's background stream.
test('claude run (c): an echo after the result opens a synthetic turn on the run stream', async () => {
  const trace = await replayClaudeRun('claude-injection-post-result', 'hold');

  assert.deepEqual(trace.events.map((event) => event.type), [
    'engine_started',
    'cost_record',
    'foreground_result',
    // The foreground turn closes on its own result (`hold` keeps the stream open)...
    'phase',
    'injection_delivered',
    // ...the injected message's reply opens its own turn...
    'phase',
    'assistant_text',
    'background_result',
    // ...and the run ends by itself once that reply has landed. Nothing has to cancel it: the
    // obligation the injection created is released when the turn it opened does, and the turn's
    // result reports no work left.
    'phase',
  ]);
  assert.equal(trace.turnError, null);
  assert.equal(trace.settled?.total_cost_usd, 0.5, 'the run reports the whole run, not the last turn');

  const delivered = one(trace, 'injection_delivered');
  assert.equal(delivered.foldedIntoTurn, false);
  assert.deepEqual(trace.steers, [{
    text: 'TEXT-INTERRUPTED: use the short form', accepted: true, injectionId: delivered.injectionId,
  }]);
  // The user turn closes on its own result, BEFORE the injection is acknowledged.
  const foreground = one(trace, 'foreground_result').result;
  assert.equal(foreground.num_turns, 2);
  assert.equal(foreground.total_cost_usd, 0.25);
  assert.equal(foreground.finalOutput, null);
  assert.equal(trace.result?.total_cost_usd, 0.25);
  const text = one(trace, 'assistant_text');
  assert.equal(text.phase, 'background');
  assert.equal(text.text, 'Short form applied.');
  const background = one(trace, 'background_result').result;
  assert.equal(background.total_cost_usd, 0.25);
  assert.equal(background.finalOutput, 'Short form applied.');
  assert.equal(background.pendingBackgroundTasks, 0);
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, false, false, true, false]);
});

// (d) A backgrounded native subagent keeps streaming after its parent turn closed. The run that
// owns it holds the background phase, so with no turn open its lines reach the run's background
// stream carrying attribution — and must not open a continuation turn.
test('claude run (d): orphan subagent lines reach the run stream with attribution, opening no turn', async () => {
  const trace = await replayClaudeRun('claude-subagent-orphan', 'hold');

  assert.deepEqual(trace.events.map((event) => event.type), [
    'engine_started',
    'assistant_text',
    'turn_progress',
    'cost_record',
    'foreground_result',
    'phase',
    'tool_use',
    'tool_result',
    'assistant_text',
    'subagent_end',
  ]);
  assert.equal(trace.turnError, null);

  const attribution = {
    parentToolUseId: 'toolu_parent01', type: 'Explore', description: null, model: 'claude-opus-5',
  };
  const toolUse = one(trace, 'tool_use');
  assert.equal(toolUse.phase, 'background');
  assert.equal(toolUse.name, 'Read');
  assert.equal(toolUse.toolUseId, 'toolu_child01');
  assert.deepEqual(toolUse.subagent, attribution);
  const toolResult = one(trace, 'tool_result');
  assert.equal(toolResult.phase, 'background');
  assert.equal(toolResult.toolUseId, 'toolu_child01');
  assert.equal(toolResult.content, 'file body');
  assert.equal(toolResult.ok, true);
  // A tool_result rides a `user` envelope, which carries no model.
  assert.deepEqual(toolResult.subagent, { ...attribution, model: null });
  // The subagent's report is attributed too, so it cannot be read as the answer.
  const texts = eventsOf(trace, 'assistant_text');
  assert.equal(texts[0].phase, 'foreground');
  assert.equal(texts[0].subagent, undefined);
  assert.equal(texts[1].phase, 'background');
  assert.equal(texts[1].text, '## Report\nno leaks found');
  assert.deepEqual(texts[1].subagent, attribution);
  // The backend's own task lifecycle seals it — no main-agent line is needed.
  const end = one(trace, 'subagent_end');
  assert.equal(end.phase, 'background');
  assert.equal(end.parentToolUseId, 'toolu_parent01');
  assert.equal(end.status, 'completed');
  // No continuation turn opened: exactly one background boundary, the one the held run installed.
  assert.equal(eventsOf(trace, 'phase').filter((event) => event.phase === 'background').length, 1);
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, true, false, false, false, false, false]);
});

// (e) `--resume` with work orphaned by the previous process: the CLI emits the orphan
// notifications, `init` and a 0-turn result{origin:task-notification} BEFORE reading the prompt on
// stdin. Settling the user turn there resolves it empty in ~2s and drops the real work.
test('claude run (e): a resume notification-turn result does not close the user turn', async () => {
  const trace = await replayClaudeRun('claude-resume-notification-turn', 'none');

  assert.deepEqual(trace.events.map((event) => event.type), [
    'engine_started',
    'assistant_text',
    'turn_progress',
    'cost_record',
    'foreground_result',
    'phase',
  ]);
  assert.equal(trace.turnError, null);
  const text = one(trace, 'assistant_text');
  assert.equal(text.phase, 'foreground');
  assert.equal(text.text, '转换完成，两棵树都提交了');
  const foreground = one(trace, 'foreground_result').result;
  assert.equal(foreground.num_turns, 12);
  assert.equal(foreground.total_cost_usd, 0.9);
  assert.equal(foreground.finalOutput, '转换完成，两棵树都提交了');
  // The 0-turn notification result produced nothing at all: only the real reply and the user
  // turn's own result are present.
  assert.equal(eventsOf(trace, 'foreground_result').length, 1);
  assert.equal(trace.raw.filter((event) => event.type === 'turn_complete').length, 1);
  // Still open across the notification result and the orphan notices — nothing owes a continuation.
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, true, true, true, true, true, false]);
});
