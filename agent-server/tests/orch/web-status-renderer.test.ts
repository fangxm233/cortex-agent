// input:  web background hold driven by a fake run's background-phase events
// output: status, resume, timeout, and seal regressions
// pos:    Web background-task hold unit tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { holdWebSessionForBackground } from '../../src/orchestration/web-status-renderer.js';
import type { RunEvent } from '../../src/domain/runs/events.js';
import type { RunObserver } from '../../src/domain/runs/request.js';

function makeHarness() {
  const statuses: Array<{ running: boolean; backgroundRunning: boolean }> = [];
  const assistants: Array<{ text: string; subagent: any }> = [];
  const tools: Array<{ name: string; input: any; subagent: any }> = [];
  const contexts: number[] = [];
  const rateLimits: any[] = [];
  const notices: Array<{ text: string; level: string; action: any }> = [];
  const track: number[] = [];
  let resumable = true;
  // The hold subscribes to the RUN; the harness drives it with the same events production emits.
  // WHICH bound the run arms, and pausing it while a continuation streams, are pinned in
  // tests/runs/service.test.ts — here we deliver the verdict straight.
  let observer: RunObserver | null = null;
  let claimed = false;
  const run = {
    claimBackgroundTranscript(): void { claimed = true; },
    subscribe(o: RunObserver): () => void { observer = o; return () => { observer = null; }; },
  };

  let abort: (() => void) | null = null;

  const install = (result: any): boolean =>
    holdWebSessionForBackground({
      result,
      run,
      registerAbort: (a) => { abort = a; },
      track: (d) => track.push(d),
      publishStatus: (p) => statuses.push(p),
      publishAssistant: (text, subagent) => assistants.push({ text, subagent }),
      publishTool: (name, input, _id, subagent) => tools.push({ name, input, subagent }),
      publishContextUsage: (usage) => contexts.push(usage.contextWindow),
      publishNotice: (text, level, action) => { notices.push({ text, level, action }); },
      onRateLimited: (continuation) => { rateLimits.push(continuation); return resumable; },
    });

  const emit = (event: RunEvent): void => {
    assert.ok(observer, 'no observer subscribed — the hold did not install');
    observer!.onEvent(event);
  };

  return {
    statuses, assistants, tools, contexts, rateLimits, notices, track,
    install, emit,
    setResumable: (value: boolean) => { resumable = value; },
    get subscribed() { return observer !== null; },
    get claimedTranscript() { return claimed; },
    get abort() { return abort; },
    text: (text: string, subagent?: any) => emit({
      type: 'assistant_text', phase: 'background', text, ...(subagent ? { subagent } : {}),
    } as RunEvent),
    tool: (name: string, input: any, toolUseId = '', subagent?: any) => emit({
      type: 'tool_use', phase: 'background', name, input, toolUseId, ...(subagent ? { subagent } : {}),
    } as RunEvent),
    ctx: (usage: any) => emit({ type: 'context_usage', phase: 'background', ...usage } as RunEvent),
    result: (r: any) => emit({ type: 'background_result', result: r }),
    grace: () => emit({ type: 'background_timeout', reason: 'grace' }),
    maxWait: () => emit({ type: 'background_timeout', reason: 'max-wait' }),
  };
}

test('hold: running task → holds (running+backgroundRunning), busy +1, subscribes to the run', () => {
  const h = makeHarness();
  const held = h.install({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0 });
  assert.equal(held, true, 'hold installed');
  assert.deepEqual(h.statuses, [{ running: true, backgroundRunning: true }], 'held state published');
  assert.deepEqual(h.track, [+1], 'busy bracket +1');
  assert.ok(h.subscribed, 'subscribed to the run');
  assert.ok(h.claimedTranscript, 'claims the background transcript so nothing double-writes it');
});

test('hold: nothing remaining → no hold, no publish (defensive re-guard)', () => {
  const h = makeHarness();
  const held = h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0 });
  assert.equal(held, false);
  assert.deepEqual(h.statuses, []);
  assert.deepEqual(h.track, []);
  assert.equal(h.subscribed, false, 'nothing to hold → nothing subscribed');
});

test('hold: continuation with 0 remaining → seal (running:false, busy -1)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.result({ pendingBackgroundTasks: 0 });
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'sealed idle');
  assert.deepEqual(h.track, [+1, -1], 'busy bracket balanced');
});

test('hold: continuation assistant text, tool call, and context stream as session events', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.text('background done: OK');
  h.text('');
  h.tool('Bash', { command: 'echo hi' });
  h.ctx({ usedTokens: 500, contextWindow: 1_000_000, percent: 0.05, accuracy: 'exact' });
  assert.deepEqual(h.assistants.map((a) => a.text), ['background done: OK'], 'empty text is dropped');
  assert.deepEqual(h.tools, [{ name: 'Bash', input: { command: 'echo hi' }, subagent: undefined }]);
  assert.deepEqual(h.contexts, [1_000_000]);
});

test('hold: foreground-phase events belong to the turn that already ended, not to the hold', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.emit({ type: 'assistant_text', phase: 'foreground', text: 'in-turn prose' } as RunEvent);
  h.emit({ type: 'tool_use', phase: 'foreground', name: 'Bash', input: {}, toolUseId: 'u1' } as RunEvent);
  h.emit({ type: 'context_usage', phase: 'foreground', usedTokens: 1, contextWindow: 2, percent: 0.5, accuracy: 'exact' } as RunEvent);
  assert.deepEqual(h.assistants, [], 'foreground prose is the transcript sink\'s job');
  assert.deepEqual(h.tools, []);
  assert.deepEqual(h.contexts, []);
});

test('hold: chained continuation (remaining>0) → re-publish held state, keep waiting', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.result({ pendingBackgroundTasks: 2 });
  assert.deepEqual(h.statuses.at(-1), { running: true, backgroundRunning: true }, 're-held');
  assert.deepEqual(h.track, [+1], 'still bracketed (no settle yet)');
  h.result({ pendingBackgroundTasks: 0 });
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'eventually sealed');
  assert.deepEqual(h.track, [+1, -1]);
});

test('hold: the run\'s grace verdict seals the session idle', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 2 });
  h.grace();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'grace seal');
  assert.deepEqual(h.track, [+1, -1]);
});

test('hold: max-wait cap → publish running:false but stay subscribed for a late continuation', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.maxWait();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'released to idle');
  assert.deepEqual(h.track, [+1, -1], 'bracket released at the cap');
  // A very late continuation still streams and re-seals (no throw).
  h.text('late background result');
  h.result({ pendingBackgroundTasks: 0 });
  assert.deepEqual(h.assistants.map((a) => a.text), ['late background result'], 'late output still delivered');
});

test('hold: the run reaching phase done releases the busy bracket', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.emit({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
  assert.deepEqual(h.track, [+1, -1], 'bracket released when the run is over');
});

test('hold: interrupted continuation → seal idle (never leaves the session running)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.result({ backgroundInterrupted: true });
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  assert.deepEqual(h.track, [+1, -1]);
});

test('hold: rate-limited continuation → request resume once, then seal idle', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  const continuation = { rateLimited: true, pendingBackgroundTasks: 1 } as any;
  h.result(continuation);
  h.result(continuation);
  assert.deepEqual(h.rateLimits, [continuation]);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  assert.deepEqual(h.track, [+1, -1]);
});

// --- The rate-limit card. The backend streams the 429 as ordinary assistant prose before the
// continuation settles; only the result says whether it was a pause or a real failure.

const RATE_LIMIT_TEXT =
  "API Error: Server is temporarily limiting requests (not your usage limit) · This request "
  + "would exceed your account's rate limit. Please try again later.";

test('hold: resumable rate limit → auto-resume notice replaces the raw API-error line', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.text(RATE_LIMIT_TEXT);
  assert.deepEqual(h.assistants, [], 'the card is held, not streamed');
  h.result({ rateLimited: true });
  assert.deepEqual(h.assistants, [], 'held card dropped — the turn paused, it did not fail');
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].level, 'warning');
  assert.deepEqual(h.notices[0].action, { kind: 'cancel-resume' });
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
});

test('hold: non-resumable rate limit → the held API-error card is shown as an error notice', () => {
  const h = makeHarness();
  h.setResumable(false);
  h.install({ pendingBackgroundTasks: 1 });
  h.text(RATE_LIMIT_TEXT);
  h.result({ rateLimited: true });
  assert.deepEqual(h.notices, [{ text: RATE_LIMIT_TEXT, level: 'error', action: undefined }]);
});

test('hold: a continuation that recovers still reports its mid-flight API error', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.text(RATE_LIMIT_TEXT);
  h.text('recovered: suite green');
  h.result({ pendingBackgroundTasks: 0 });
  assert.deepEqual(h.assistants.map((a) => a.text), ['recovered: suite green']);
  assert.deepEqual(h.notices, [{ text: RATE_LIMIT_TEXT, level: 'error', action: undefined }]);
});

test('hold: a subagent API error keeps its attribution and is never held', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.text(RATE_LIMIT_TEXT, { toolUseId: 'toolu_1' });
  assert.deepEqual(h.assistants.map((a) => a.text), [RATE_LIMIT_TEXT]);
  assert.deepEqual(h.notices, []);
});

// --- User Stop during the hold. The execution is gone from the live-run registry by the time the
// hold is installed, so the cancel path reaches the hold through this abort handle instead.

test('hold: registers an abort handle while held (Stop has something to call)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  assert.equal(typeof h.abort, 'function', 'abort handle exposed');
});

test('hold: nothing to hold → no abort handle registered', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0 });
  assert.equal(h.abort, null);
});

test('hold: abort → seals idle and releases the busy bracket (Stop is not a no-op)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.abort!();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'sealed on Stop');
  assert.deepEqual(h.track, [+1, -1], 'busy bracket balanced');
});

test('hold: abort is idempotent and wins over a later interrupt/continuation seal', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.abort!();
  const after = h.statuses.length;
  h.abort!();
  // The kill the cancel path issues alongside the abort lands here moments later.
  h.result({ backgroundInterrupted: true });
  assert.equal(h.statuses.length, after, 'no duplicate status publishes');
  assert.deepEqual(h.track, [+1, -1], 'bracket released exactly once');
});

test('hold: abort after a max-wait release still seals only once', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.maxWait(); // publishes running:false but stays subscribed (not sealed)
  const after = h.statuses.length;
  h.abort!();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  assert.equal(h.statuses.length, after + 1, 'abort seals the still-subscribed hold');
  assert.deepEqual(h.track, [+1, -1], 'bracket not double-released');
});

// Which BOUND the wait gets, and pausing it while a continuation streams, are the RUN's job now
// (tests/runs/service.test.ts). What stays here: a chained continuation keeps the session held,
// and only a 0-remaining result seals it.
test('hold: chained work keeps the hold; the final result seals it', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 });
  assert.deepEqual(h.track, [+1], 'busy bracket held for the whole window');
  h.text('working…');
  h.result({ pendingBackgroundTasks: 1 });
  assert.deepEqual(h.statuses.at(-1), { running: true, backgroundRunning: true }, 'still held');
  h.result({ pendingBackgroundTasks: 0 });
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false }, 'sealed by the final result');
  assert.deepEqual(h.track, [+1, -1]);
});

test('hold: after a seal, a late continuation reporting more work does not flip running back on', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 });
  h.grace();
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  const after = h.statuses.length;
  h.text('late');
  h.result({ pendingBackgroundTasks: 3 });
  assert.equal(h.statuses.length, after, 'no running:true with nothing left to seal it');
  assert.deepEqual(h.track, [+1, -1], 'bracket not re-taken');
  assert.deepEqual(h.assistants.map((a) => a.text), ['late'], 'output still streams');
});

test('hold: a background subagent\'s output keeps its attribution', () => {
  // The subagent that a turn spawned in the background finishes AFTER that turn ends, so its
  // output arrives through the run's background phase rather than the in-turn path. When this seam
  // dropped the attribution, the subagent's final report was published as the agent's own prose
  // — surfacing in the NEXT turn, ungrouped.
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });

  const subagent = { parentToolUseId: 'toolu_bg', type: 'Explore', description: 'survey', model: 'claude-haiku-4-5' };
  h.text('subagent findings', subagent);
  h.tool('Grep', { pattern: 'x' }, 'toolu_child', subagent);
  h.text('the agent speaking for itself');

  assert.deepEqual(h.assistants, [
    { text: 'subagent findings', subagent },
    { text: 'the agent speaking for itself', subagent: undefined },
  ]);
  assert.deepEqual(h.tools, [{ name: 'Grep', input: { pattern: 'x' }, subagent }]);
});
