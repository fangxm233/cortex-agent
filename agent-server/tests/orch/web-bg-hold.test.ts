// input:  web background hold, resume callback, injected timers
// output: status, resume, guard, timeout, and seal regressions
// pos:    Web background-task hold unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { holdWebForBg } from '../../src/orchestration/web-bg-hold.js';
import type { ContinuationSink } from '../../src/agent-adapter/types.js';

interface FakeTimer { fn: () => void; ms: number; id: number }

function makeHarness() {
  const statuses: Array<{ running: boolean; backgroundRunning: boolean }> = [];
  const assistants: Array<{ text: string; subagent: any }> = [];
  const tools: Array<{ name: string; input: any; subagent: any }> = [];
  const contexts: number[] = [];
  const rateLimits: any[] = [];
  const notices: Array<{ text: string; level: string; action: any }> = [];
  const track: number[] = [];
  let resumable = true;
  let sink: ContinuationSink | null = null;

  let pending: FakeTimer | null = null;
  let nextId = 1;
  const timers = {
    set: (fn: () => void, ms: number): unknown => { const id = nextId++; pending = { fn, ms, id }; return id; },
    clear: (id: unknown): void => { if (pending && pending.id === id) pending = null; },
  };

  let abort: (() => void) | null = null;

  const install = (result: any): boolean =>
    holdWebForBg({
      result,
      registerSink: (s) => { sink = s; },
      registerAbort: (a) => { abort = a; },
      track: (d) => track.push(d),
      publishStatus: (p) => statuses.push(p),
      publishAssistant: (text, subagent) => assistants.push({ text, subagent }),
      publishTool: (name, input, _id, subagent) => tools.push({ name, input, subagent }),
      publishContextUsage: (usage) => contexts.push(usage.contextWindow),
      publishNotice: (text, level, action) => { notices.push({ text, level, action }); },
      onRateLimited: (continuation) => { rateLimits.push(continuation); return resumable; },
      guardTimers: timers,
    });

  return {
    statuses, assistants, tools, contexts, rateLimits, notices, track,
    install,
    setResumable: (value: boolean) => { resumable = value; },
    get sink() { return sink!; },
    get abort() { return abort; },
    get pendingMs() { return pending?.ms ?? null; },
    fire: () => { if (pending) { const f = pending.fn; pending = null; f(); } },
  };
}

test('holdWebForBg: running task → holds (running+backgroundRunning), busy +1, registers sink', () => {
  const h = makeHarness();
  const held = h.install({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0 });
  assert.equal(held, true, 'hold installed');
  assert.deepEqual(h.statuses, [{ running: true, backgroundRunning: true }], 'held state published');
  assert.deepEqual(h.track, [+1], 'busy bracket +1');
  assert.ok(h.sink, 'sink registered');
});

test('holdWebForBg: nothing remaining → no hold, no publish (defensive re-guard)', () => {
  const h = makeHarness();
  const held = h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0 });
  assert.equal(held, false);
  assert.deepEqual(h.statuses, []);
  assert.deepEqual(h.track, []);
});

test('holdWebForBg: continuation with 0 remaining → seal (running:false, busy -1)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onResult({ pendingBackgroundTasks: 0 } as any);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'sealed idle');
  assert.deepEqual(h.track, [+1, -1], 'busy bracket balanced');
});

test('holdWebForBg: continuation assistant text, tool call, and context stream as session events', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onAssistantText('background done: OK');
  h.sink.onAssistantText('');
  h.sink.onToolUse!('Bash', { command: 'echo hi' });
  h.sink.onContextUsage?.({
    usedTokens: 500, contextWindow: 1_000_000, percent: 0.05, accuracy: 'exact',
  });
  assert.deepEqual(h.assistants.map((a) => a.text), ['background done: OK'], 'empty text is dropped');
  assert.deepEqual(h.tools, [{ name: 'Bash', input: { command: 'echo hi' }, subagent: undefined }]);
  assert.deepEqual(h.contexts, [1_000_000]);
});

test('holdWebForBg: chained continuation (remaining>0) → re-publish held state, keep waiting', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onResult({ pendingBackgroundTasks: 2 } as any);
  assert.deepEqual(h.statuses.at(-1), { running: true, backgroundRunning: true }, 're-held');
  assert.deepEqual(h.track, [+1], 'still bracketed (no settle yet)');
  h.sink.onResult({ pendingBackgroundTasks: 0 } as any);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'eventually sealed');
  assert.deepEqual(h.track, [+1, -1]);
});

test('holdWebForBg: undelivered-only → grace timer; firing it seals idle', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 2 });
  assert.equal(h.pendingMs, 90_000, 'grace watchdog armed (default 90s)');
  h.fire();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'grace seal');
  assert.deepEqual(h.track, [+1, -1]);
});

test('holdWebForBg: max-wait cap → publish running:false but keep sink for a late continuation', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  assert.equal(h.pendingMs, 1_800_000, 'max-wait cap armed (default 30min)');
  h.fire();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'released to idle');
  assert.deepEqual(h.track, [+1, -1], 'bracket released at the cap');
  // A very late continuation still streams and re-seals (no throw).
  h.sink.onAssistantText('late background result');
  h.sink.onResult({ pendingBackgroundTasks: 0 } as any);
  assert.deepEqual(h.assistants.map((a) => a.text), ['late background result'], 'late output still delivered');
});

test('holdWebForBg: interrupted continuation → seal idle (never leaves the session running)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onResult({ backgroundInterrupted: true } as any);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  assert.deepEqual(h.track, [+1, -1]);
});

test('holdWebForBg: rate-limited continuation → request resume once, then seal idle', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  const continuation = { rateLimited: true, pendingBackgroundTasks: 1 } as any;
  h.sink.onResult(continuation);
  h.sink.onResult(continuation);
  assert.deepEqual(h.rateLimits, [continuation]);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  assert.deepEqual(h.track, [+1, -1]);
});

// --- The rate-limit card. The backend streams the 429 as ordinary assistant prose before the
// continuation settles; only the result says whether it was a pause or a real failure.

const RATE_LIMIT_TEXT =
  "API Error: Server is temporarily limiting requests (not your usage limit) · This request "
  + "would exceed your account's rate limit. Please try again later.";

test('holdWebForBg: resumable rate limit → auto-resume notice replaces the raw API-error line', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onAssistantText(RATE_LIMIT_TEXT);
  assert.deepEqual(h.assistants, [], 'the card is held, not streamed');
  h.sink.onResult({ rateLimited: true } as any);
  assert.deepEqual(h.assistants, [], 'held card dropped — the turn paused, it did not fail');
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].level, 'warning');
  assert.deepEqual(h.notices[0].action, { kind: 'cancel-resume' });
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
});

test('holdWebForBg: non-resumable rate limit → the held API-error card is shown as an error notice', () => {
  const h = makeHarness();
  h.setResumable(false);
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onAssistantText(RATE_LIMIT_TEXT);
  h.sink.onResult({ rateLimited: true } as any);
  assert.deepEqual(h.notices, [{ text: RATE_LIMIT_TEXT, level: 'error', action: undefined }]);
});

test('holdWebForBg: a continuation that recovers still reports its mid-flight API error', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onAssistantText(RATE_LIMIT_TEXT);
  h.sink.onAssistantText('recovered: suite green');
  h.sink.onResult({ pendingBackgroundTasks: 0 } as any);
  assert.deepEqual(h.assistants.map((a) => a.text), ['recovered: suite green']);
  assert.deepEqual(h.notices, [{ text: RATE_LIMIT_TEXT, level: 'error', action: undefined }]);
});

test('holdWebForBg: a subagent API error keeps its attribution and is never held', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onAssistantText(RATE_LIMIT_TEXT, undefined, { toolUseId: 'toolu_1' } as any);
  assert.deepEqual(h.assistants.map((a) => a.text), [RATE_LIMIT_TEXT]);
  assert.deepEqual(h.notices, []);
});

// --- User Stop during the hold. The execution is gone from runningExecutions by the time the hold
// is installed, so the cancel path reaches the hold through this abort handle instead.

test('holdWebForBg: registers an abort handle while held (Stop has something to call)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  assert.equal(typeof h.abort, 'function', 'abort handle exposed');
});

test('holdWebForBg: nothing to hold → no abort handle registered', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0 });
  assert.equal(h.abort, null);
});

test('holdWebForBg: abort → seals idle and releases the busy bracket (Stop is not a no-op)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.abort!();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'sealed on Stop');
  assert.deepEqual(h.track, [+1, -1], 'busy bracket balanced');
  assert.equal(h.pendingMs, null, 'guard timer cleared');
});

test('holdWebForBg: abort is idempotent and wins over a later interrupt/continuation seal', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.abort!();
  const after = h.statuses.length;
  h.abort!();
  // The kill the cancel path issues alongside the abort lands here moments later.
  h.sink.onResult({ backgroundInterrupted: true } as any);
  assert.equal(h.statuses.length, after, 'no duplicate status publishes');
  assert.deepEqual(h.track, [+1, -1], 'bracket released exactly once');
});

test('holdWebForBg: abort after a max-wait release still seals only once', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.fire(); // max-wait cap: publishes running:false but keeps the sink (not sealed)
  const after = h.statuses.length;
  h.abort!();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  assert.equal(h.statuses.length, after + 1, 'abort seals the still-registered hold');
  assert.deepEqual(h.track, [+1, -1], 'bracket not double-released');
});

// The wait watchdogs bound the WAIT for the continuation, not the continuation: a turn that
// opens and then runs longer than the grace/max-wait window must not be sealed idle mid-stream
// (2026-09-06: a 93-minute continuation streamed into a session already flipped to idle).
test('holdWebForBg: continuation turn opening pauses the watchdog; its result re-arms or seals', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 });
  assert.equal(h.pendingMs, 90_000, 'grace armed while waiting for the turn');
  h.sink.onTurnOpen!();
  assert.equal(h.pendingMs, null, 'no watchdog while the continuation streams');
  assert.deepEqual(h.track, [+1], 'busy bracket still held');
  h.sink.onAssistantText('working…');
  h.sink.onResult({ pendingBackgroundTasks: 1 } as any);
  assert.equal(h.pendingMs, 1_800_000, 'chained work re-arms the cap');
  assert.deepEqual(h.statuses.at(-1), { running: true, backgroundRunning: true });
  h.sink.onTurnOpen!();
  h.sink.onResult({ pendingBackgroundTasks: 0 } as any);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'sealed by the final result');
  assert.deepEqual(h.track, [+1, -1]);
});

test('holdWebForBg: after a seal, a late continuation reporting more work does not flip running back on', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 });
  h.fire(); // grace seal
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  const after = h.statuses.length;
  h.sink.onAssistantText('late');
  h.sink.onResult({ pendingBackgroundTasks: 3 } as any);
  assert.equal(h.statuses.length, after, 'no running:true with nothing left to seal it');
  assert.deepEqual(h.track, [+1, -1], 'bracket not re-taken');
  assert.deepEqual(h.assistants.map((a) => a.text), ['late'], 'output still streams');
});

test('holdWebForBg: a background subagent\'s output keeps its attribution', () => {
  // The subagent that a turn spawned in the background finishes AFTER that turn ends, so its
  // output arrives through the continuation sink rather than the in-turn path. When this seam
  // dropped the attribution, the subagent's final report was published as the agent's own prose
  // — surfacing in the NEXT turn, ungrouped.
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });

  const subagent = { parentToolUseId: 'toolu_bg', type: 'Explore', description: 'survey', model: 'claude-haiku-4-5' };
  h.sink.onAssistantText('subagent findings', null, subagent as any);
  h.sink.onToolUse?.('Grep', { pattern: 'x' }, 'toolu_child', subagent as any);
  h.sink.onAssistantText('the agent speaking for itself');

  assert.deepEqual(h.assistants, [
    { text: 'subagent findings', subagent },
    { text: 'the agent speaking for itself', subagent: undefined },
  ]);
  assert.deepEqual(h.tools, [{ name: 'Grep', input: { pattern: 'x' }, subagent }]);
});
