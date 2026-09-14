// input:  createResumeTargetSink with injected store seams, RunEvent shapes
// output: when a backend resume target is written, and when writing it is skipped
// pos:    resume-target-sink contract — the mid-turn half of first-turn resume durability
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // first — keep the store singletons off the real data home
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { createResumeTargetSink } from '../../src/orchestration/resume-target-sink.js';
import type { RunEvent } from '../../src/domain/runs/events.js';

type Write = { sessionName: string; backendSessionId: string; lastUsedAt: string };

function recorder() {
  const writes: Write[] = [];
  return {
    writes,
    deps: {
      update: async (sessionName: string, updates: { backendSessionId: string; lastUsedAt: string }) => {
        writes.push({ sessionName, ...updates });
      },
      now: () => '2026-01-01T00:00:00.000Z',
    },
  };
}

const engineStarted = (backendSessionId: string): RunEvent =>
  ({ type: 'engine_started', backendSessionId }) as RunEvent;

test('a fresh turn writes the backend id the engine announces, before the turn settles', async () => {
  const { writes, deps } = recorder();
  const sink = createResumeTargetSink({ sessionName: 'cortex-fresh', resumedFrom: null, deps });

  await sink.onEvent(engineStarted('B-1'));
  await sink.drain();

  assert.deepEqual(writes, [{ sessionName: 'cortex-fresh', backendSessionId: 'B-1', lastUsedAt: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(sink.written, 'B-1');
});

test('the id already on disk is never re-written', async () => {
  const { writes, deps } = recorder();
  const sink = createResumeTargetSink({ sessionName: 'cortex-resumed', resumedFrom: 'B-old', deps });

  sink.persist('B-old');
  await sink.onEvent(engineStarted('B-old'));
  await sink.drain();

  assert.deepEqual(writes, [], 'a resumed turn that stays on its session writes nothing');
});

test('a backend that comes back on a DIFFERENT session records the new resume target', async () => {
  const { writes, deps } = recorder();
  const sink = createResumeTargetSink({ sessionName: 'cortex-reset', resumedFrom: 'B-old', deps });

  await sink.onEvent(engineStarted('B-new'));
  await sink.drain();

  assert.deepEqual(writes.map((w) => w.backendSessionId), ['B-new']);
});

test('repeated announcements of the same id collapse into one write', async () => {
  const { writes, deps } = recorder();
  const sink = createResumeTargetSink({ sessionName: 'cortex-dedup', resumedFrom: null, deps });

  sink.persist('B-1');
  sink.persist('B-1');
  await sink.onEvent(engineStarted('B-1'));
  await sink.drain();

  assert.equal(writes.length, 1);
});

test('an engine that never announces is read off the live run on its first event', async () => {
  const { writes, deps } = recorder();
  let live: string | null = null;
  const sink = createResumeTargetSink({
    sessionName: 'cortex-live', resumedFrom: null, deps, liveBackendSessionId: () => live,
  });

  await sink.onEvent({ type: 'assistant_text', text: 'hi', phase: 'foreground' } as RunEvent);
  await sink.drain();
  assert.deepEqual(writes, [], 'nothing to write while the engine has not named itself');

  live = 'B-late';
  await sink.onEvent({ type: 'assistant_text', text: 'hi', phase: 'foreground' } as RunEvent);
  await sink.drain();
  assert.deepEqual(writes.map((w) => w.backendSessionId), ['B-late']);
});

test('a failed write is swallowed: a registry error must not break the turn', async () => {
  const sink = createResumeTargetSink({
    sessionName: 'cortex-broken',
    resumedFrom: null,
    deps: { update: async () => { throw new Error('disk full'); }, now: () => 'T' },
  });

  sink.persist('B-1');
  await sink.drain(); // resolves, does not reject
  assert.equal(sink.written, 'B-1');
});

test('writes are serialized in announcement order', async () => {
  const order: string[] = [];
  let release: (() => void) | null = null;
  const sink = createResumeTargetSink({
    sessionName: 'cortex-order',
    resumedFrom: null,
    deps: {
      update: async (_name, updates) => {
        if (updates.backendSessionId === 'B-1') {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        order.push(updates.backendSessionId);
      },
      now: () => 'T',
    },
  });

  sink.persist('B-1');
  sink.persist('B-2');
  await Promise.resolve();
  release?.();
  await sink.drain();

  assert.deepEqual(order, ['B-1', 'B-2']);
});
