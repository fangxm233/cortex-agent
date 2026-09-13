// input:  fixtures/runs/claude-*.jsonl replayed through replay-harness.replayClaudeRun
// output: regression spec for Claude run phases and sink delivery order
// pos:    P0.1 baseline — the behaviour Phase 1/2 must keep for continuation, injection, orphan
//         subagents and the resume notification turn
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { replayClaudeRun, type ClaudeRunTrace } from './replay-harness.js';

/** The delivery order of a run, with each entry narrowed to the sink call it was. */
function kinds(trace: ClaudeRunTrace): string[] {
  return trace.observed.map((observation) => observation.kind);
}

function observation(trace: ClaudeRunTrace, kind: string): any {
  const found = trace.observed.filter((observation) => observation.kind === kind);
  assert.equal(found.length, 1, `expected exactly one ${kind}, got ${found.length}`);
  return found[0];
}

// (a) A background task outliving its user turn: the result reports it as still running, and the
// CLI's later re-invocation of the model is delivered through the ContinuationSink.
test('claude run (a): a background task outliving the turn is delivered by a continuation turn', async () => {
  const trace = await replayClaudeRun('claude-bg-continuation');

  assert.deepEqual(kinds(trace), [
    'turn.tool_use',
    'turn.result',
    'continuation.turn_open',
    'continuation.assistant_text',
    'continuation.result',
  ]);
  assert.equal(trace.turnError, null);

  assert.deepEqual(observation(trace, 'turn.tool_use'), {
    step: 3, kind: 'turn.tool_use', name: 'Bash', toolUseId: 'toolu_bg01', subagent: null,
  });
  // The count that makes orchestration hold the status open instead of sealing it.
  assert.deepEqual(observation(trace, 'turn.result'), {
    step: 6,
    kind: 'turn.result',
    result: {
      sessionId: 'test-session',
      num_turns: 2,
      total_cost_usd: 0.25,
      finalOutput: null,
      pendingBackgroundTasks: 1,
      undeliveredBackgroundTasks: 0,
      rateLimited: false,
    },
  });
  // The synthetic continuation turn opens before it speaks, and its reply arrives on the sink.
  assert.deepEqual(observation(trace, 'continuation.turn_open'), { step: 8, kind: 'continuation.turn_open' });
  assert.deepEqual(observation(trace, 'continuation.assistant_text'), {
    step: 8, kind: 'continuation.assistant_text', text: 'Background task done: DONE', subagent: null,
  });
  // Cost is the turn DELTA against the session cursor, not the cumulative total in the line.
  assert.deepEqual(observation(trace, 'continuation.result'), {
    step: 9,
    kind: 'continuation.result',
    result: {
      sessionId: 'test-session',
      num_turns: 1,
      total_cost_usd: 0.25,
      finalOutput: 'Background task done: DONE',
      pendingBackgroundTasks: 0,
      undeliveredBackgroundTasks: 0,
      rateLimited: false,
    },
  });
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, true, true, false, false, true, false]);
});

// (b) The injected message is consumed on a tool-result boundary while the turn is live: it folds
// into that turn (one ack, foldedIntoTurn=true) and no continuation turn is opened.
test('claude run (b): an echo before the result folds the injection into the running turn', async () => {
  const trace = await replayClaudeRun('claude-injection-folded');

  assert.deepEqual(kinds(trace), [
    'turn.tool_use',
    'turn.tool_result',
    'injection.write',
    'injection.delivered',
    'turn.assistant_text',
    'turn.result',
  ]);
  assert.equal(trace.turnError, null);

  assert.deepEqual(observation(trace, 'injection.write'), {
    step: 5, kind: 'injection.write', text: 'EARLY-STOP: report what you have', accepted: true,
  });
  assert.deepEqual(observation(trace, 'injection.delivered'), {
    step: 6, kind: 'injection.delivered', text: 'EARLY-STOP: report what you have', foldedIntoTurn: true,
  });
  assert.deepEqual(observation(trace, 'turn.result'), {
    step: 8,
    kind: 'turn.result',
    result: {
      sessionId: 'test-session',
      num_turns: 2,
      total_cost_usd: 0.02,
      finalOutput: 'EARLY-STOP',
      pendingBackgroundTasks: 0,
      undeliveredBackgroundTasks: 0,
      rateLimited: false,
    },
  });
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, true, true, true, true, false]);
});

// (c) The CLI drains the queue only after this turn's result: the echo then acks the injection as a
// NEW turn (foldedIntoTurn=false) and that turn's reply must reach the sink, not be dropped.
test('claude run (c): an echo after the result opens a synthetic turn on the sink', async () => {
  const trace = await replayClaudeRun('claude-injection-post-result');

  assert.deepEqual(kinds(trace), [
    'injection.write',
    'turn.result',
    'injection.delivered',
    'continuation.turn_open',
    'continuation.assistant_text',
    'continuation.result',
  ]);
  assert.equal(trace.turnError, null);

  assert.deepEqual(observation(trace, 'injection.write'), {
    step: 3, kind: 'injection.write', text: 'TEXT-INTERRUPTED: use the short form', accepted: true,
  });
  // The user turn closes on its own result, BEFORE the injection is acknowledged.
  assert.deepEqual(observation(trace, 'turn.result'), {
    step: 4,
    kind: 'turn.result',
    result: {
      sessionId: 'test-session',
      num_turns: 2,
      total_cost_usd: 0.25,
      finalOutput: null,
      pendingBackgroundTasks: 0,
      undeliveredBackgroundTasks: 0,
      rateLimited: false,
    },
  });
  assert.deepEqual(observation(trace, 'injection.delivered'), {
    step: 5, kind: 'injection.delivered', text: 'TEXT-INTERRUPTED: use the short form', foldedIntoTurn: false,
  });
  assert.deepEqual(observation(trace, 'continuation.assistant_text'), {
    step: 6, kind: 'continuation.assistant_text', text: 'Short form applied.', subagent: null,
  });
  assert.deepEqual(observation(trace, 'continuation.result'), {
    step: 7,
    kind: 'continuation.result',
    result: {
      sessionId: 'test-session',
      num_turns: 1,
      total_cost_usd: 0.25,
      finalOutput: 'Short form applied.',
      pendingBackgroundTasks: 0,
      undeliveredBackgroundTasks: 0,
      rateLimited: false,
    },
  });
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, false, false, true, false]);
});

// (d) A backgrounded native subagent keeps streaming after its parent turn closed. With no turn
// open its lines reach the sink carrying attribution — and must not open a continuation turn.
test('claude run (d): orphan subagent lines reach the sink with attribution, opening no turn', async () => {
  const trace = await replayClaudeRun('claude-subagent-orphan');

  assert.deepEqual(kinds(trace), [
    'continuation.tool_use',
    'continuation.tool_result',
    'continuation.assistant_text',
    'continuation.subagent_end',
  ]);
  assert.equal(trace.turnError, null, 'no user turn was ever opened');

  const attribution = { parentToolUseId: 'toolu_parent01', type: 'Explore' };
  assert.deepEqual(observation(trace, 'continuation.tool_use'), {
    step: 3, kind: 'continuation.tool_use', name: 'Read', toolUseId: 'toolu_child01', subagent: attribution,
  });
  assert.deepEqual(observation(trace, 'continuation.tool_result'), {
    step: 4,
    kind: 'continuation.tool_result',
    toolUseId: 'toolu_child01',
    content: 'file body',
    isError: false,
    subagent: attribution,
  });
  // The subagent's report is attributed too, so it cannot be read as the answer.
  assert.deepEqual(observation(trace, 'continuation.assistant_text'), {
    step: 5, kind: 'continuation.assistant_text', text: '## Report\nno leaks found', subagent: attribution,
  });
  // The backend's own task lifecycle seals it — no main-agent line is needed.
  assert.deepEqual(observation(trace, 'continuation.subagent_end'), {
    step: 6, kind: 'continuation.subagent_end', parentToolUseId: 'toolu_parent01', status: 'completed',
  });
  assert.deepEqual(trace.turnOpenAtStep, [false, false, false, false, false, false]);
});

// (e) `--resume` with work orphaned by the previous process: the CLI emits the orphan
// notifications, `init` and a 0-turn result{origin:task-notification} BEFORE reading the prompt on
// stdin. Settling the user turn there resolves it empty in ~2s and drops the real work.
test('claude run (e): a resume notification-turn result does not close the user turn', async () => {
  const trace = await replayClaudeRun('claude-resume-notification-turn');

  // The 0-turn notification result (line 7) produced nothing at all: the only calls are the real
  // reply and the user turn's own result.
  assert.deepEqual(kinds(trace), ['turn.assistant_text', 'turn.result']);
  assert.equal(trace.turnError, null);
  assert.deepEqual(observation(trace, 'turn.assistant_text'), {
    step: 8, kind: 'turn.assistant_text', text: '转换完成，两棵树都提交了', subagent: null,
  });
  assert.deepEqual(observation(trace, 'turn.result'), {
    step: 9,
    kind: 'turn.result',
    result: {
      sessionId: 'test-session',
      num_turns: 12,
      total_cost_usd: 0.9,
      finalOutput: '转换完成，两棵树都提交了',
      pendingBackgroundTasks: 0,
      undeliveredBackgroundTasks: 0,
      rateLimited: false,
    },
  });
  // Still open across the notification result and the orphan notices — nothing owes a continuation.
  assert.deepEqual(trace.turnOpenAtStep, [false, true, true, true, true, true, true, true, false]);
});
