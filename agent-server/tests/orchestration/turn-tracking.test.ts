import { test } from 'vitest';
import { CLAUDE_SELECTION, PI_SELECTION } from './selection-fixture.js';
import assert from 'node:assert/strict';
import {
  consumePendingTurnSupersession,
  finishTurnTracking,
  initTurnTracking,
  isTurnTrackingPending,
  markPendingTurnSuperseded,
} from '../../src/orchestration/turn/turn-tracking.js';
import {
  acquireTurnMutationLock,
  tryAcquireTurnMutationLock,
} from '../../src/orchestration/turn-mutation-lock.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('turn mutation lock claims atomically and hands off queued owners', async () => {
  const first = tryAcquireTurnMutationLock('lock-channel');
  assert.ok(first);
  assert.equal(tryAcquireTurnMutationLock('lock-channel'), null);

  let secondSettled = false;
  const second = acquireTurnMutationLock('lock-channel').then((release) => {
    secondSettled = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(secondSettled, false);

  first();
  const releaseSecond = await second;
  assert.equal(secondSettled, true);
  releaseSecond();
  const third = tryAcquireTurnMutationLock('lock-channel');
  assert.ok(third);
  third();
});

test('stale generation finish and supersession cannot affect the next turn', async () => {
  const channel = 'generation-channel';
  const deps = {
    getSelection: () => CLAUDE_SELECTION,
    ledger: {
      initAndBeginTurn: async () => ({ turn: {} as never, turnIndex: 0 }),
    },
    anchorEnd: async () => null,
  };
  const first = await initTurnTracking(channel, 'track-1', null, 'm1', 'one', 's1', { deps });
  const secondPending = initTurnTracking(channel, 'track-1', null, 'm2', 'two', 's2', { deps });
  markPendingTurnSuperseded(channel);

  finishTurnTracking(channel, first);
  const second = await secondPending;
  assert.equal(isTurnTrackingPending(channel), true);
  assert.equal(consumePendingTurnSupersession(channel, first), false);
  assert.equal(consumePendingTurnSupersession(channel, second), true);
  finishTurnTracking(channel, first);
  assert.equal(isTurnTrackingPending(channel), true, 'stale finish leaves the current generation held');
  finishTurnTracking(channel, second);
  assert.equal(isTurnTrackingPending(channel), false);
});

test('idle user acceptance publishes after the turn anchor is recorded and before backend start', async () => {
  const order: string[] = [];
  const anchorRead = deferred<{ file: string; after: string } | null>();
  const deps = {
    getSelection: () => PI_SELECTION,
    ledger: {
      initAndBeginTurn: async (_channel: string, opts: { anchor?: unknown }) => {
        order.push(`ledger:${JSON.stringify(opts.anchor)}`);
        return { turn: {} as never, turnIndex: 7 };
      },
    },
    anchorEnd: async (backend: string, backendSessionId: string) => {
      order.push(`anchor-start:${backend}:${backendSessionId}`);
      const anchor = await anchorRead.promise;
      order.push('anchor-end');
      return anchor;
    },
  };

  let settled = false;
  const tracking = initTurnTracking(
    'web:track-1',
    'track-1',
    'backend-1',
    'message-1',
    'hello',
    'status-1',
    { onAccepted: () => { order.push('accepted'); }, deps },
  );
  void tracking.then(() => { settled = true; });

  for (let step = 0; step < 10 && !order.some((item) => item.startsWith('anchor-start:')); step++) {
    await Promise.resolve();
  }
  assert.equal(isTurnTrackingPending('web:track-1'), true);
  assert.equal(settled, false, 'turn tracking remains behind the unread anchor');
  assert.ok(!order.includes('accepted'), 'acceptance cannot expose a rewindable turn before its anchor');
  markPendingTurnSuperseded('web:track-1');

  anchorRead.resolve({ file: '/sessions/target.jsonl', after: 'e9' });
  const token = await tracking;
  assert.equal(typeof token, 'symbol');
  assert.equal(consumePendingTurnSupersession('web:track-1', token), true);
  assert.equal(consumePendingTurnSupersession('web:track-1', token), false);
  assert.equal(isTurnTrackingPending('web:track-1'), true, 'guard remains held until backend registration');
  finishTurnTracking('web:track-1', token);
  assert.equal(isTurnTrackingPending('web:track-1'), false);
  order.push('backend-start');

  assert.deepEqual(order, [
    'anchor-start:pi:backend-1',
    'anchor-end',
    'ledger:{"file":"/sessions/target.jsonl","after":"e9"}',
    'accepted',
    'backend-start',
  ]);
});

test('a Claude turn anchors in the transcript under the session\'s spawn cwd', async () => {
  const calls: string[] = [];
  const deps = {
    getSelection: () => CLAUDE_SELECTION,
    ledger: { initAndBeginTurn: async () => ({ turn: {} as never, turnIndex: 1 }) },
    anchorEnd: async (backend: string, id: string, cwd?: string) => { calls.push(`${backend}:${id}:${cwd}`); return null; },
    spawnCwd: async () => '/srv/workspaces/w1',
  };
  const token = await initTurnTracking('web:track-2', 'track-2', 'backend-2', 'm', 'hi', 's', { deps });
  finishTurnTracking('web:track-2', token);
  assert.deepEqual(calls, ['claude:backend-2:/srv/workspaces/w1']);
});
