// input:  Node test runner + orchestration/web-bg-hold (real bg-wait-guard, injected timers)
// output: holdWebForBg spec — status publishes (running/backgroundRunning), busy bracket balance,
//         continuation streaming (assistant/tool), chained re-arm, grace/max-wait/interrupt seal
// pos:    CC web background-task hold unit tests (the web analogue of lifecycle-bg-hold)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import test from 'node:test';
import assert from 'node:assert/strict';

import { holdWebForBg } from '../../src/orchestration/web-bg-hold.js';
import type { ContinuationSink } from '../../src/agent-adapter/types.js';

interface FakeTimer { fn: () => void; ms: number; id: number }

function makeHarness() {
  const statuses: Array<{ running: boolean; backgroundRunning: boolean }> = [];
  const assistants: string[] = [];
  const tools: Array<{ name: string; input: any }> = [];
  const track: number[] = [];
  let sink: ContinuationSink | null = null;

  let pending: FakeTimer | null = null;
  let nextId = 1;
  const timers = {
    set: (fn: () => void, ms: number): unknown => { const id = nextId++; pending = { fn, ms, id }; return id; },
    clear: (id: unknown): void => { if (pending && pending.id === id) pending = null; },
  };

  const install = (result: any): boolean =>
    holdWebForBg({
      result,
      registerSink: (s) => { sink = s; },
      track: (d) => track.push(d),
      publishStatus: (p) => statuses.push(p),
      publishAssistant: (text) => assistants.push(text),
      publishTool: (name, input) => tools.push({ name, input }),
      guardTimers: timers,
    });

  return {
    statuses, assistants, tools, track,
    install,
    get sink() { return sink!; },
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

test('holdWebForBg: continuation assistant text + tool call stream as session events', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onAssistantText('background done: OK');
  h.sink.onAssistantText('');
  h.sink.onToolUse!('Bash', { command: 'echo hi' });
  assert.deepEqual(h.assistants, ['background done: OK'], 'empty text is dropped');
  assert.deepEqual(h.tools, [{ name: 'Bash', input: { command: 'echo hi' } }]);
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
  assert.deepEqual(h.assistants, ['late background result'], 'late output still delivered');
});

test('holdWebForBg: interrupted continuation → seal idle (never leaves the session running)', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onResult({ backgroundInterrupted: true } as any);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  assert.deepEqual(h.track, [+1, -1]);
});

test('holdWebForBg: rate-limited continuation → seal idle', () => {
  const h = makeHarness();
  h.install({ pendingBackgroundTasks: 1 });
  h.sink.onResult({ rateLimited: true, pendingBackgroundTasks: 1 } as any);
  assert.deepEqual(h.statuses.at(-1), { running: false, backgroundRunning: false });
  assert.deepEqual(h.track, [+1, -1]);
});
