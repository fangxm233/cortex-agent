// input:  orchestration/turn/active-turns.ts
// output: the per-channel streaming slot and the edit-supersede flag it took over in T2.1
//
// The streaming-slot case moved here from tests/runs/registry.test.ts; the supersede cases are
// covered end-to-end in tests/orch/superseded-edits.test.ts (which calls the same three methods —
// the `supersededEdits` facade it used to import was deleted in T4.1).
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

import { activeTurns } from '../../src/orchestration/turn/active-turns.js';

beforeEach(() => activeTurns._reset());

test('streaming slot set / get / clear', () => {
  assert.equal(activeTurns.streamingCallback('web:abc'), null);

  const cb = (text: string) => { void text; };
  activeTurns.setStreamingCallback('web:abc', cb);
  assert.equal(activeTurns.streamingCallback('web:abc'), cb);

  activeTurns.clearStreamingCallback('web:abc');
  assert.equal(activeTurns.streamingCallback('web:abc'), null);
});

test('the streaming slot outlives its turn — a background hold keeps streaming after unregister', () => {
  const turn = { channel: 'web:abc', sessionId: 's1' };
  const cb = (text: string) => { void text; };
  activeTurns.register('web:abc', turn);
  activeTurns.setStreamingCallback('web:abc', cb);

  activeTurns.unregister('web:abc', turn);
  assert.equal(activeTurns.has('web:abc'), false);
  assert.equal(activeTurns.streamingCallback('web:abc'), cb, 'the hold still owns the reply');
});

test('releaseStreamingCallback is scoped to the registering callback', () => {
  const held = (text: string) => { void text; };
  const successor = (text: string) => { void text; };
  activeTurns.setStreamingCallback('slack:D1', held);

  // The next turn claimed the channel before the previous turn's background hold sealed.
  activeTurns.setStreamingCallback('slack:D1', successor);
  assert.equal(activeTurns.releaseStreamingCallback('slack:D1', held), false,
    'the old hold no longer owns the slot, so its seal releases nothing');
  assert.equal(activeTurns.streamingCallback('slack:D1'), successor, 'the successor keeps streaming');

  assert.equal(activeTurns.releaseStreamingCallback('slack:D1', successor), true);
  assert.equal(activeTurns.streamingCallback('slack:D1'), null);
  assert.equal(activeTurns.releaseStreamingCallback('slack:D1', successor), false,
    'releasing an empty slot reports nothing to release');
});

test('register / unregister is scoped to the registering turn', () => {
  const first = { channel: 'web:abc', sessionId: 's1' };
  const second = { channel: 'web:abc', sessionId: 's1' };
  activeTurns.register('web:abc', first);
  activeTurns.register('web:abc', second);

  activeTurns.unregister('web:abc', first);
  assert.equal(activeTurns.get('web:abc'), second, 'the loser on the way out cannot erase the winner');

  activeTurns.unregister('web:abc', second);
  assert.equal(activeTurns.get('web:abc'), null);
});

test('markSuperseded / isSuperseded / clearSuperseded are per channel and per reason', () => {
  activeTurns.markSuperseded('web:a', 'edit');
  assert.equal(activeTurns.isSuperseded('web:a', 'edit'), true);
  assert.equal(activeTurns.isSuperseded('web:b', 'edit'), false);

  assert.equal(activeTurns.clearSuperseded('web:a', 'edit'), true);
  assert.equal(activeTurns.clearSuperseded('web:a', 'edit'), false, 'clearing twice reports nothing to clear');
});
