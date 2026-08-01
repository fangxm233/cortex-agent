// input:  turn tracking with deferred ledger and backup
// output: snapshot, acceptance, backend ordering regression
// pos:    Specifies the idle turn snapshot barrier
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  consumePendingTurnSupersession,
  finishTurnTracking,
  initTurnTracking,
  isTurnTrackingPending,
  markPendingTurnSuperseded,
} from '../../src/orchestration/lifecycle.js';
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
    resolveBackend: () => 'claude',
    getProfile: () => 'default',
    ledger: {
      initAndBeginTurn: async () => ({ turn: {} as never, turnIndex: 0 }),
      setBackupPath: async () => {},
    },
    backup: {
      findPISessionFile: async () => null,
      backupSessionFile: async () => null,
      createBackup: async () => null,
    },
  };
  const first = await initTurnTracking(channel, 'track-1', null, 'cortex-1', 'm1', 'one', 's1', { deps });
  const secondPending = initTurnTracking(channel, 'track-1', null, 'cortex-1', 'm2', 'two', 's2', { deps });
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

test('idle user acceptance publishes after snapshot completion and before backend start', async () => {
  const order: string[] = [];
  const copy = deferred<string | null>();
  const deps = {
    resolveBackend: () => 'pi',
    getProfile: () => 'execute',
    ledger: {
      initAndBeginTurn: async () => {
        order.push('ledger');
        return { turn: {} as never, turnIndex: 7 };
      },
      setBackupPath: async (_channel: string, _messageId: string, backupPath: string | null) => {
        order.push(`backup-path:${backupPath}`);
      },
    },
    backup: {
      findPISessionFile: async (sessionId: string) => {
        order.push(`find:${sessionId}`);
        return '/sessions/target.jsonl';
      },
      backupSessionFile: async (filePath: string, turnIndex: number) => {
        order.push(`copy-start:${filePath}:${turnIndex}`);
        const result = await copy.promise;
        order.push('copy-end');
        return result;
      },
      createBackup: async () => null,
    },
  };

  let settled = false;
  const tracking = initTurnTracking(
    'web:track-1',
    'track-1',
    'backend-1',
    'cortex-1',
    'message-1',
    'hello',
    'status-1',
    { onAccepted: () => { order.push('accepted'); }, deps },
  );
  void tracking.then(() => { settled = true; });

  for (let step = 0; step < 10 && !order.some((item) => item.startsWith('copy-start:')); step++) {
    await Promise.resolve();
  }
  assert.equal(isTurnTrackingPending('web:track-1'), true);
  assert.equal(settled, false, 'turn tracking remains behind the incomplete snapshot');
  assert.ok(order.includes('copy-start:/sessions/target.jsonl:7'));
  assert.ok(!order.includes('accepted'), 'acceptance cannot expose a rewindable turn before its snapshot');
  markPendingTurnSuperseded('web:track-1');

  copy.resolve('/sessions/target.jsonl.turn-7.bak');
  const token = await tracking;
  assert.equal(typeof token, 'symbol');
  assert.equal(consumePendingTurnSupersession('web:track-1', token), true);
  assert.equal(consumePendingTurnSupersession('web:track-1', token), false);
  assert.equal(isTurnTrackingPending('web:track-1'), true, 'guard remains held until backend registration');
  finishTurnTracking('web:track-1', token);
  assert.equal(isTurnTrackingPending('web:track-1'), false);
  order.push('backend-start');

  assert.deepEqual(order, [
    'ledger',
    'find:backend-1',
    'copy-start:/sessions/target.jsonl:7',
    'copy-end',
    'backup-path:/sessions/target.jsonl.turn-7.bak',
    'accepted',
    'backend-start',
  ]);
});
