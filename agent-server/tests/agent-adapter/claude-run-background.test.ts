// input:  ClaudeAdapter.open over a scripted fake CLI, with a background task and its continuation
// output: end-to-end spec for the engine-owned background phase of one run (policy per mode)
// pos:    The run-lifecycle contract: `EngineRun.events` carries the whole run, result follows policy
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ClaudeAdapter } from '../../src/agent-adapter/claude/adapter.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

/**
 * A fake CLI child: each write to stdin consumes the next script and replays it on stdout. A test
 * stages the background half by hand with `emitLines`, which is the only way to model a
 * continuation — the CLI opens that turn on its own, with no prompt behind it.
 */
function scriptedChild(scripts: unknown[][]) {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => true;
  child.emitLines = (lines: unknown[]) => {
    for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
  };
  const queue = [...scripts];
  child.stdin.on('data', () => {
    const next = queue.shift();
    if (next) setImmediate(() => child.emitLines(next));
  });
  return child;
}

function specFor(sessionKey: string, scripts: unknown[][], children: any[]) {
  return engineSpecFixture({
    sessionId: 'bg-run',
    sessionKey,
    resume: false,
    captureTranscriptLogs: false,
    processSpawner: (() => {
      const child = scriptedChild(scripts);
      children.push(child);
      return { process: child };
    }) as any,
  });
}

const TASK_STARTED = { type: 'system', subtype: 'task_started', task_id: 'bg-1', task_type: 'local_bash' };
const TASK_NOTIFICATION = {
  type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed', summary: 'done',
};
/** A foreground turn that leaves one background task running. */
const FOREGROUND = [
  TASK_STARTED,
  { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'started it' }] } },
  {
    type: 'result', subtype: 'success', is_error: false,
    num_turns: 1, total_cost_usd: 0.25, session_id: 'bg-run', result: 'started it',
  },
];
const CONTINUATION = [
  TASK_NOTIFICATION,
  { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'task finished: DONE' }] } },
  {
    // A continuation reports its own cost only when it also reports usage; without the `usage`
    // block the adapter (correctly) refuses to claim one, and the merge would add nothing.
    type: 'result', subtype: 'success', is_error: false, origin: { kind: 'task-notification' },
    num_turns: 1, total_cost_usd: 0.01, session_id: 'bg-run', result: 'task finished: DONE',
    usage: {
      iterations: [{
        input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300,
        output_tokens: 80,
      }],
    },
    modelUsage: { 'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 900000 } },
  },
];

async function drain(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

/** Run one turn and hand back the events as they arrive, so a test can react to the foreground
 *  result before the continuation lands. */
function drive(adapter: ClaudeAdapter, sessionKey: string, children: any[], awaitBackground: string) {
  const engine = adapter.open(specFor(sessionKey, [FOREGROUND], children));
  const run = engine.run({ text: 'go' } as any, { awaitBackground: awaitBackground as any });
  const events: RunEvent[] = [];
  const collect = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  return { engine, run, events, collect };
}

async function untilEvent(events: RunEvent[], type: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`no ${type} event arrived`);
}

test('hold: the run streams its background turn and ends when the work is gone', async (t) => {
  const adapter = new ClaudeAdapter();
  const children: any[] = [];
  const { engine, run, events, collect } = drive(adapter, 'bg-run-hold', children, 'hold');
  t.onTestFinished(() => { void engine.close(); });

  await untilEvent(events, 'foreground_result');
  const foreground = events.find((e) => e.type === 'foreground_result') as Extract<RunEvent, { type: 'foreground_result' }>;
  assert.equal(foreground.result.pendingBackgroundTasks, 1, 'the turn left one task running');

  // The polled surface can already read its result while the stream stays open.
  const firstSettled = await run.result;
  assert.equal(firstSettled.total_cost_usd, 0.25);

  children[0].emitLines(CONTINUATION);
  await collect;

  assert.deepEqual(events.map((e) => e.type), [
    'engine_started',
    'assistant_text',
    'turn_progress',
    'cost_record',        // derived from the settled turn, before the result event
    'foreground_result',
    'phase',              // entering the background phase
    'phase',              // the continuation turn opened
    'assistant_text',
    'context_usage',      // the continuation's own provider call
    'cost_record',
    'background_result',
    'phase',              // done
  ]);
  const backgroundText = events.filter((e) => e.type === 'assistant_text').at(-1) as Extract<RunEvent, { type: 'assistant_text' }>;
  assert.equal(backgroundText.text, 'task finished: DONE');
  assert.equal(backgroundText.phase, 'background');
  assert.deepEqual(events.at(-1), {
    type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0,
  });
});

test('none: the run ends at its foreground result and the late continuation is not its business', async (t) => {
  const adapter = new ClaudeAdapter();
  const children: any[] = [];
  const { engine, run, events, collect } = drive(adapter, 'bg-run-none', children, 'none');
  t.onTestFinished(() => { void engine.close(); });

  await untilEvent(events, 'foreground_result');
  children[0].emitLines(CONTINUATION);
  await collect;

  assert.deepEqual(events.map((e) => e.type), [
    'engine_started', 'assistant_text', 'turn_progress', 'cost_record', 'foreground_result', 'phase',
  ]);
  const settled = await run.result;
  assert.equal(settled.total_cost_usd, 0.25, 'a foreground-only run reports its own turn');
});

test('inline: the run awaits the continuation and settles with the merged tally', async (t) => {
  const adapter = new ClaudeAdapter();
  const children: any[] = [];
  const { engine, run, events, collect } = drive(adapter, 'bg-run-inline', children, 'inline');
  t.onTestFinished(() => { void engine.close(); });

  await untilEvent(events, 'foreground_result');
  children[0].emitLines(CONTINUATION);
  await collect;

  assert.deepEqual(events.map((e) => e.type), [
    'engine_started', 'assistant_text', 'turn_progress', 'cost_record', 'foreground_result',
    'phase', 'phase', 'assistant_text', 'context_usage', 'cost_record', 'background_result', 'phase',
  ]);
  const settled = await run.result;
  // "The whole run" is what the tally proves: the continuation's turns and its final output are in
  // the value the caller awaits. (Its own cost lands as a separate `cost_record` event — a
  // task-notification result reports cost 0 of its own, which the merge does not invent.)
  assert.equal(settled.num_turns, 2, 'an inline caller gets the whole run, not one turn');
  assert.equal(settled.finalOutput, 'task finished: DONE');
  assert.equal(settled.total_cost_usd, 0.25);
  const background = events.find((e) => e.type === 'background_result') as Extract<RunEvent, { type: 'background_result' }>;
  assert.equal(background.result.reportedAccounting?.usageReported, true, 'the continuation reported usage');
});
