// input:  mid-turn injection with deferred durable-store and backend-ack seams
// output: persist-before-publish and ack-latch ordering regressions
// pos:    durable phase-one ordering specification for pending injection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  tryInjectIntoLiveTurn,
  _test as injectTest,
  type MidTurnInjectDeps,
} from '../../src/orchestration/mid-turn-inject.js';

beforeEach(() => injectTest.reset());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(persist: Promise<void>) {
  const order: string[] = [];
  const proc: any = {
    ackSink: null,
    continuationSink: null,
    injectUserMessage: () => true,
    setInjectionAckSink(sink: any) { proc.ackSink = sink; },
    setContinuationSink(sink: any) { proc.continuationSink = sink; },
  };
  const deps: MidTurnInjectDeps = {
    getLiveExecutions: () => [{ backend: 'claude', agentProcess: proc }],
    getStreamingCallback: () => null,
    appendAssistant: () => {},
    appendTool: () => {},
    publishMessage: (ev) => { order.push(`publish:${ev.pendingId}`); },
    publishDelivered: (ev) => { order.push(`delivered:${ev.pendingId}`); },
    publishStatus: () => {},
    persistPending: async () => { order.push('persist-start'); await persist; order.push('persist-end'); },
    commitPending: async () => { order.push('commit'); return { committedTs: 'T-commit' }; },
    createPendingId: () => 'pin-1',
    track: (delta) => { order.push(`track:${delta}`); },
    now: () => 'T-write',
  } as MidTurnInjectDeps;
  return { deps, proc, order };
}

const ctx = {
  channel: 'web:sess-1', sessionId: 'sess-1', sessionName: 'cortex-nimbus',
  profileName: 'default', text: 'change direction', senderId: 'U1', messageId: 'web-1',
};

test('accepted injection is durably stored before its pending event is published', async () => {
  const gate = deferred();
  const h = harness(gate.promise);
  const attempt = tryInjectIntoLiveTurn(h.deps, ctx);

  await Promise.resolve();
  assert.deepEqual(h.order, ['track:1', 'persist-start']);
  gate.resolve();
  assert.equal(await attempt, true);
  assert.deepEqual(h.order, ['track:1', 'persist-start', 'persist-end', 'publish:pin-1']);
});

test('an ack arriving during the durable write is latched until pending has been published', async () => {
  const gate = deferred();
  const h = harness(gate.promise);
  const attempt = tryInjectIntoLiveTurn(h.deps, ctx);

  await Promise.resolve();
  assert.ok(h.proc.ackSink, 'ack sink is registered before awaiting disk so an early echo is not lost');
  const ack = h.proc.ackSink.onDelivered({ text: 'change direction', foldedIntoTurn: true });
  gate.resolve();
  await attempt;
  await ack;

  assert.deepEqual(h.order, [
    'track:1', 'persist-start', 'persist-end', 'publish:pin-1',
    'commit', 'delivered:pin-1', 'track:-1',
  ]);
});

test('a failed active-store write falls back to a committed transcript instead of ephemeral pending state', async () => {
  const h = harness(Promise.reject(new Error('disk full')));

  assert.equal(await tryInjectIntoLiveTurn(h.deps, ctx), true);

  assert.deepEqual(h.order, [
    'track:1', 'persist-start', 'commit', 'delivered:pin-1',
  ]);
  assert.ok(!h.order.some((item) => item.startsWith('publish:')), 'nothing is called pending unless phase one is durable');
});
