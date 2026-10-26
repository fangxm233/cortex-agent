// Direct unit tests for ClaudeTurnMachine: a fake TurnHost stands in for the process half, so each
// test drives the machine with raw CLI lines and asserts on how turns open, settle and fail.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { ClaudeTurnMachine, type TurnHost } from '../../src/agent-adapter/claude/turn-machine.js';
import { ClaudeContextUsageTracker } from '../../src/agent-adapter/claude/context-usage.js';
import { CancelledError } from '../../src/agent-adapter/claude/defaults.js';
import type { BackgroundTurnSink, BackgroundWake, RateLimitObservation, RateLimitOrigin } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';

type HostCall = 'resetIdle' | 'bumpTurnIdle' | 'clearTurnIdle';

function makeHost(over: Partial<{ anthropicBaseUrl: string; writable: boolean; writeThrows: boolean }> = {}) {
  const calls: HostCall[] = [];
  const written: string[] = [];
  const rateLimits: { info: RateLimitObservation; origin: RateLimitOrigin }[] = [];
  let rateLimitError: Error | null = null;
  const host: TurnHost = {
    sessionId: 'sess-0001',
    channel: 'C1',
    captureTranscriptLogs: false,
    anthropicBaseUrl: over.anthropicBaseUrl,
    reportRateLimit(info, origin) {
      rateLimits.push({ info, origin });
      return rateLimitError ? Promise.reject(rateLimitError) : Promise.resolve();
    },
    canWriteStdin: () => over.writable ?? true,
    writeTurnStdin(prompt) {
      if (over.writeThrows) throw new Error('EPIPE');
      written.push(prompt);
    },
    resetIdleTimer: () => { calls.push('resetIdle'); },
    bumpTurnIdleTimer: () => { calls.push('bumpTurnIdle'); },
    clearTurnIdleTimer: () => { calls.push('clearTurnIdle'); },
  };
  return { host, calls, written, rateLimits, failRateLimit: (e: Error) => { rateLimitError = e; } };
}

function makeMachine(over: Parameters<typeof makeHost>[0] = {}) {
  const h = makeHost(over);
  const machine = new ClaudeTurnMachine(h.host, new ClaudeContextUsageTracker('claude-sonnet-4-6'));
  return { machine, ...h };
}

/** Open a foreground turn the way `ClaudeSession.sendMessage` does and expose its outcome. */
function startTurn(machine: ClaudeTurnMachine, options: Record<string, unknown> = {}) {
  const outcome: { value?: any; error?: any; settled: boolean } = { settled: false };
  const promise = new Promise<any>((resolve, reject) => {
    machine.registerTurn(
      (v: any) => { outcome.value = v; outcome.settled = true; resolve(v); },
      (e: Error) => { outcome.error = e; outcome.settled = true; reject(e); },
      machine.createTurnStreams('hello'),
      options,
    );
  });
  promise.catch(() => {});
  return { outcome, promise };
}

function makeSink() {
  const events: string[] = [];
  const results: AgentResult[] = [];
  const texts: string[] = [];
  const wakes: (BackgroundWake | undefined)[] = [];
  const sink: BackgroundTurnSink = {
    onTurnOpen: (wake) => { events.push('open'); wakes.push(wake); },
    onAssistantText: (text) => { events.push('text'); texts.push(text); },
    onToolUse: () => { events.push('tool_use'); },
    onSubagentEnd: (id, status) => { events.push(`end:${id}:${status}`); },
    onResult: (r) => { events.push('result'); results.push(r); },
  };
  return { sink, events, results, texts, wakes };
}

const line = (data: unknown) => JSON.stringify(data);
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }] }, ...extra });
const result = (extra: Record<string, unknown> = {}) =>
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'sess-0001', ...extra });
const taskStarted = (id: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_bash', ...extra });
const taskUpdated = (id: string, patch: Record<string, unknown>) =>
  line({ type: 'system', subtype: 'task_updated', task_id: id, patch });
const taskNotification = (id: string, status = 'completed') =>
  line({ type: 'system', subtype: 'task_notification', task_id: id, status, summary: 'done' });
const replay = (text: string) =>
  line({ type: 'user', isReplay: true, message: { role: 'user', content: text } });

// --- turn start / end ---

test('a result line settles the open turn with its output and hands the idle timers back', async () => {
  const { machine, calls } = makeMachine();
  const progress: number[] = [];
  const { promise } = startTurn(machine, { onProgress: (p: any) => progress.push(p.num_turns) });

  machine.handleLine(assistant('first'));
  machine.handleLine(assistant('the answer'));
  assert.ok(machine.currentTurn, 'the turn stays open until its result');
  machine.handleLine(result({ num_turns: 2, modelUsage: { 'claude-sonnet-4-6': {} } }));

  const value = await promise;
  assert.equal(value.finalOutput, 'the answer');
  assert.equal(value.num_turns, 2);
  assert.equal(value.pendingBackgroundTasks, 0);
  assert.equal(value.reportedAccounting.model, 'claude-sonnet-4-6');
  assert.deepEqual(progress, [1, 2]);
  assert.equal(machine.currentTurn, null);
  assert.equal(machine.lastModelName, 'claude-sonnet-4-6');
  // Every line keeps both timers alive; settling clears the turn-idle one.
  assert.ok(calls.filter((c) => c === 'resetIdle').length >= 3);
  assert.equal(calls.at(-1), 'clearTurnIdle');
});

test('turn cost is the delta of the cumulative total, starting at the restored baseline', async () => {
  const { machine } = makeMachine();
  machine.resetCostBaseline(1.0);

  const first = startTurn(machine);
  machine.handleLine(result({ total_cost_usd: 1.25 }));
  assert.equal((await first.promise).total_cost_usd, 0.25);

  const second = startTurn(machine);
  machine.handleLine(result({ total_cost_usd: 1.75 }));
  assert.equal((await second.promise).total_cost_usd, 0.5);

  // A total that went backwards (new CLI session) never bills a negative turn.
  const third = startTurn(machine);
  machine.handleLine(result({ total_cost_usd: 0.1 }));
  assert.equal((await third.promise).total_cost_usd, 0);
});

test('an is_error result rejects the turn with the reported errors', async () => {
  const { machine } = makeMachine();
  const { promise, outcome } = startTurn(machine);
  machine.handleLine(result({ is_error: true, subtype: 'error_during_execution', errors: ['No conversation found'] }));
  await assert.rejects(promise, /No conversation found/);
  assert.equal(outcome.settled, true);
  assert.equal(machine.currentTurn, null);
});

test('a callback that throws does not stop the turn from settling', async () => {
  const { machine } = makeMachine();
  const { promise } = startTurn(machine, {
    onToolUse: () => { throw new Error('ui exploded'); },
    onToolResult: () => { throw new Error('ui exploded'); },
  });
  machine.handleLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }));
  machine.handleLine(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }));
  machine.handleLine(assistant('done'));
  machine.handleLine(result());
  assert.equal((await promise).finalOutput, 'done');
});

test('a non-JSON line is ignored and does not settle anything', () => {
  const { machine } = makeMachine();
  const { outcome } = startTurn(machine);
  machine.handleLine('Warning: something on stdout');
  machine.handleLine('');
  assert.equal(outcome.settled, false);
  assert.ok(machine.currentTurn);
});

// --- quota / rate limits ---

test('a rate-limit result resolves (not rejects) and is flagged rateLimited', async () => {
  const { machine } = makeMachine();
  const { promise } = startTurn(machine);
  machine.handleLine(result({ is_error: true, result: "You've hit your limit · resets 5pm" }));
  const value = await promise;
  assert.equal(value.rateLimited, true);
  assert.match(value.rateLimitMessage, /hit your limit/);
});

test('rate_limit_event is reported to the host with the mode from the base URL, turn or no turn', async () => {
  const { machine, rateLimits, failRateLimit } = makeMachine({ anthropicBaseUrl: 'http://127.0.0.1:9000/m/plan/anthropic' });
  const info = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.91, resetsAt: 1_900_000_000 };

  machine.handleLine(line({ type: 'rate_limit_event', rate_limit_info: info }));
  assert.equal(machine.currentTurn, null);
  assert.deepEqual(rateLimits, [{ info, origin: { provider: 'anthropic', displayName: 'Anthropic', mode: 'plan' } }]);

  // A failing throttle sink is logged, never thrown into the line handler or the turn.
  failRateLimit(new Error('store down'));
  const { promise } = startTurn(machine);
  machine.handleLine(line({ type: 'rate_limit_event', rate_limit_info: info }));
  machine.handleLine(result());
  await promise;
  assert.equal(rateLimits.length, 2);
});

test('rate_limit_event without a /m/<mode>/ base URL carries no mode', () => {
  const { machine, rateLimits } = makeMachine();
  machine.handleLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }));
  assert.equal(rateLimits[0].origin.mode, undefined);
});

// --- background / foreground tasks ---

test('a background task outlives its turn: counted at result, holds idle until it is delivered', async () => {
  const { machine } = makeMachine();
  const { promise } = startTurn(machine);
  machine.handleLine(taskStarted('bg1'));
  machine.handleLine(result());
  assert.equal((await promise).pendingBackgroundTasks, 1);
  assert.equal(machine.holdsIdle(), true);

  machine.handleLine(taskUpdated('bg1', { status: 'completed' }));
  assert.equal(machine.holdsIdle(), true, 'finished but undelivered still holds');
  machine.handleLine(taskNotification('bg1'));
  assert.equal(machine.holdsIdle(), false);
});

test('a foreground task never counts as background work until the CLI backgrounds it', async () => {
  const { machine } = makeMachine();
  const first = startTurn(machine);
  machine.handleLine(taskStarted('fg1', { is_backgrounded: false }));
  machine.handleLine(result());
  assert.equal((await first.promise).pendingBackgroundTasks, 0);
  assert.equal(machine.holdsIdle(), false);

  const second = startTurn(machine);
  machine.handleLine(taskStarted('fg2', { is_backgrounded: false }));
  machine.handleLine(taskUpdated('fg2', { is_backgrounded: true }));
  machine.handleLine(result());
  assert.equal((await second.promise).pendingBackgroundTasks, 1);
});

test('a killed background task releases the hold with no notification', () => {
  const { machine } = makeMachine();
  machine.handleLine(taskStarted('bg1'));
  assert.equal(machine.holdsIdle(), true);
  machine.handleLine(taskUpdated('bg1', { status: 'killed' }));
  assert.equal(machine.holdsIdle(), false);
});

test('a notification observed during the turn counts as one undelivered continuation at result', async () => {
  const { machine } = makeMachine();
  const { promise } = startTurn(machine);
  machine.handleLine(taskStarted('bg1'));
  machine.handleLine(taskUpdated('bg1', { status: 'completed' }));
  machine.handleLine(taskNotification('bg1'));
  machine.handleLine(result());
  const value = await promise;
  assert.equal(value.pendingBackgroundTasks, 0);
  assert.equal(value.undeliveredBackgroundTasks, 1);
});

test('after a background notification the next assistant line opens a continuation turn for the sink', () => {
  const { machine } = makeMachine();
  const { sink, events, results, texts } = makeSink();
  machine.setBackgroundTurnSink(sink);
  const { promise } = startTurn(machine);
  machine.handleLine(taskStarted('bg1'));
  machine.handleLine(result());
  void promise;

  machine.handleLine(taskUpdated('bg1', { status: 'completed' }));
  machine.handleLine(taskNotification('bg1'));
  machine.handleLine(assistant('background job finished'));
  assert.equal(machine.currentTurn?.spontaneous, true);

  machine.handleLine(result({ origin: { kind: 'task-notification' } }));
  assert.deepEqual(events, ['open', 'text', 'result']);
  assert.deepEqual(texts, ['background job finished']);
  assert.equal(results[0].pendingBackgroundTasks, 0);
  assert.equal(machine.currentTurn, null);
});

test('a continuation opened by a background notification tells the sink what woke it', () => {
  const { machine } = makeMachine();
  const { sink, wakes } = makeSink();
  machine.setBackgroundTurnSink(sink);
  const { promise } = startTurn(machine);
  machine.handleLine(taskStarted('bg1'));
  machine.handleLine(result());
  void promise;

  machine.handleLine(taskNotification('bg1'));
  machine.handleLine(assistant('background job finished'));
  assert.deepEqual(wakes, [{ summaries: ['done'] }]);
});

test('without a background sink an unprompted assistant line opens nothing', () => {
  const { machine } = makeMachine();
  machine.handleLine(taskStarted('bg1'));
  machine.handleLine(taskNotification('bg1'));
  machine.handleLine(assistant('nobody is listening'));
  assert.equal(machine.currentTurn, null);
});

test('a notification-turn result arriving on a user turn is ignored; the real result settles it', async () => {
  const { machine } = makeMachine();
  const { promise, outcome } = startTurn(machine);
  machine.handleLine(result({ origin: { kind: 'task-notification' }, num_turns: 0 }));
  assert.equal(outcome.settled, false);
  assert.ok(machine.currentTurn);

  machine.handleLine(assistant('real work'));
  machine.handleLine(result());
  assert.equal((await promise).finalOutput, 'real work');
});

test('a subagent end reaches the open turn first, and the background sink once the turn is gone', async () => {
  const { machine } = makeMachine();
  const { sink, events } = makeSink();
  machine.setBackgroundTurnSink(sink);
  const ends: string[] = [];
  const { promise } = startTurn(machine, { onSubagentEnd: (id: string, status: string) => ends.push(`${id}:${status}`) });
  machine.handleLine(taskStarted('a1', { subagent_type: 'explore', tool_use_id: 'tu-1' }));
  machine.handleLine(taskStarted('a2', { subagent_type: 'explore', tool_use_id: 'tu-2' }));
  machine.handleLine(taskUpdated('a1', { status: 'completed' }));
  machine.handleLine(result());
  await promise;
  machine.handleLine(taskUpdated('a2', { status: 'killed' }));

  assert.deepEqual(ends, ['tu-1:completed']);
  assert.deepEqual(events, ['end:tu-2:killed']);
});

// --- mid-turn injection ---

test('injection is refused with no turn in flight, no writable stdin, or a failed write', () => {
  assert.equal(makeMachine().machine.injectUserMessage({ text: 'hi' }), false);

  const closed = makeMachine({ writable: false });
  startTurn(closed.machine);
  assert.equal(closed.machine.injectUserMessage({ text: 'hi' }), false);

  const broken = makeMachine({ writeThrows: true });
  startTurn(broken.machine);
  assert.equal(broken.machine.injectUserMessage({ text: 'hi' }), false);
  assert.equal(broken.machine.holdsIdle(), false, 'a failed write leaves nothing pending');
});

test('an injection echoed during the turn is acknowledged as folded in', async () => {
  const { machine, written } = makeMachine();
  const acks: { text: string; foldedIntoTurn: boolean }[] = [];
  machine.setInjectionAckSink({ onDelivered: (m) => acks.push(m) });
  const { promise } = startTurn(machine);

  assert.equal(machine.injectUserMessage({ text: 'also do X' }), true);
  assert.deepEqual(written, ['also do X']);
  assert.equal(machine.holdsIdle(), true);
  machine.handleLine(replay('hello'));   // the turn's own prompt: not an ack
  assert.deepEqual(acks, []);
  machine.handleLine(replay('also do X'));
  assert.deepEqual(acks, [{ text: 'also do X', foldedIntoTurn: true }]);
  assert.equal(machine.holdsIdle(), false);

  machine.handleLine(result());
  await promise;
});

test('an injection ack carries the echoed uuid as the transcript entry it is written as', async () => {
  const { machine } = makeMachine();
  const acks: unknown[] = [];
  machine.setInjectionAckSink({ onDelivered: (m) => acks.push(m) });
  const { promise } = startTurn(machine);

  machine.injectUserMessage({ text: 'also do Y' });
  machine.handleLine(line({ type: 'user', isReplay: true, uuid: 'u-77', message: { role: 'user', content: 'also do Y' } }));
  assert.deepEqual(acks, [{ text: 'also do Y', foldedIntoTurn: true, position: { before: 'u-77' } }]);

  machine.handleLine(result());
  await promise;
});

test('an injection consumed after the result opens an injected-message continuation turn', async () => {
  const { machine } = makeMachine();
  const { sink, events, texts, wakes } = makeSink();
  const acks: boolean[] = [];
  machine.setBackgroundTurnSink(sink);
  machine.setInjectionAckSink({ onDelivered: (m) => acks.push(m.foldedIntoTurn) });
  const { promise } = startTurn(machine);
  machine.injectUserMessage({ text: 'one more thing' });
  machine.handleLine(result());
  await promise;

  machine.handleLine(replay('one more thing'));
  assert.deepEqual(acks, [false]);
  assert.equal(machine.holdsIdle(), true, 'armed until the CLI opens its own turn');
  machine.handleLine(assistant('handled the extra thing'));
  assert.equal(machine.currentTurn?.spontaneous, true);
  assert.equal(machine.holdsIdle(), false);
  machine.handleLine(result());
  assert.deepEqual(events, ['open', 'text', 'result']);
  assert.deepEqual(texts, ['handled the extra thing']);
  assert.deepEqual(wakes, [undefined], 'the injected message is its own row; nothing else woke the agent');
});

// --- cancellation and process death ---

test('a killed turn rejects with CancelledError when the process closes', async () => {
  const { machine } = makeMachine();
  const { promise } = startTurn(machine);
  machine.markCurrentTurnKilled();
  machine.abortTurnOnProcessClose(null, '');
  await assert.rejects(promise, (e: unknown) => e instanceof CancelledError);
  assert.equal(machine.currentTurn, null);
});

test('a process that dies mid-turn rejects with its stderr, even on exit code 0', async () => {
  const { machine, calls } = makeMachine();
  const { promise } = startTurn(machine);
  machine.handleLine(assistant('partial'));
  machine.abortTurnOnProcessClose(0, 'segfault in the CLI');
  await assert.rejects(promise, /segfault in the CLI/);
  assert.equal(calls.at(-1), 'clearTurnIdle');
});

test('a dying spontaneous turn seals the background sink as interrupted', () => {
  const { machine } = makeMachine();
  const { sink, results } = makeSink();
  machine.setBackgroundTurnSink(sink);
  machine.handleLine(taskNotification('bg1', 'completed'));
  machine.handleLine(assistant('continuing'));
  assert.equal(machine.currentTurn?.spontaneous, true);

  machine.abortTurnOnProcessClose(1, '');
  assert.equal(results.length, 1);
  assert.equal(results[0].backgroundInterrupted, true);
  assert.equal(machine.backgroundTurnSink, null, 'single-fire: the sink is released');
});

test('notifyBgInterrupted only reports when work is still owed, and always releases the sink', () => {
  const idle = makeMachine();
  const idleSink = makeSink();
  idle.machine.setBackgroundTurnSink(idleSink.sink);
  idle.machine.notifyBgInterrupted();
  assert.deepEqual(idleSink.results, []);
  assert.equal(idle.machine.backgroundTurnSink, null);

  const busy = makeMachine();
  const busySink = makeSink();
  busy.machine.setBackgroundTurnSink(busySink.sink);
  busy.machine.handleLine(taskStarted('bg1'));
  busy.machine.notifyBgInterrupted();
  busy.machine.notifyBgInterrupted();
  assert.equal(busySink.results.length, 1);
  assert.equal(busySink.results[0].backgroundInterrupted, true);
});

test('an unacknowledged injection is sealed as interrupted when the session goes', () => {
  const { machine } = makeMachine();
  const { sink, results } = makeSink();
  machine.setBackgroundTurnSink(sink);
  startTurn(machine);
  machine.injectUserMessage({ text: 'late' });
  machine.failInFlightTurn(new Error('stdin closed'));
  machine.notifyBgInterrupted();
  assert.equal(results.length, 1);
  assert.equal(results[0].backgroundInterrupted, true);
});

test('a stdin write failure rejects the in-flight turn with that error', async () => {
  const { machine } = makeMachine();
  const { promise } = startTurn(machine);
  machine.failInFlightTurn(new Error('Failed to write to claude stdin: EPIPE'));
  await assert.rejects(promise, /EPIPE/);
  assert.equal(machine.currentTurn, null);
  // Nothing in flight: a second failure is a no-op.
  machine.failInFlightTurn(new Error('again'));
});
