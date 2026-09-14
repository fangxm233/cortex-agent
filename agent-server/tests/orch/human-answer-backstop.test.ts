// input:  the channel-keyed interceptor registry (arm / disarm / isArmed / tryConsume)
// output: unit tests for the leaf the DR-0016 backstop is built on — no manager-qa, no routing
// pos:    this module exists so the conversation entry can ask "is anyone waiting for a human reply
//         on this channel?" without importing the module that answers it (that import closes the
//         agent-runner → manager-qa → thread-callback → session-gateway → agent-runner cycle).
//         These tests therefore import NOTHING but the leaf.

import '../_test-home.js'; // MUST be first — isolates store singletons
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  arm, disarm, isArmed, tryConsume, setHumanAnswerRehydrator, _testResetHumanAnswerBackstop,
} from '../../src/orchestration/human-answer-backstop.js';

beforeEach(() => {
  _testResetHumanAnswerBackstop();
  setHumanAnswerRehydrator(() => {});
});

test('an unarmed channel consumes nothing', () => {
  assert.equal(isArmed('C-quiet'), false);
  assert.equal(tryConsume('C-quiet', 'just a normal message'), false);
});

test('an armed channel hands the text to its handler and reports consumption', () => {
  const seen: string[] = [];
  arm('C-waiting', (text) => { seen.push(text); return true; });

  assert.equal(isArmed('C-waiting'), true);
  assert.equal(tryConsume('C-waiting', 'Use strategy B.'), true);
  assert.deepEqual(seen, ['Use strategy B.']);
  assert.equal(tryConsume('C-other', 'Use strategy B.'), false, 'arming is per channel');
});

test('a handler that declines leaves the message to normal handling', () => {
  arm('C-declines', () => false);
  assert.equal(tryConsume('C-declines', 'hello'), false);
  assert.equal(isArmed('C-declines'), true, 'declining is not disarming — that is the handler’s call');
});

test('disarm stops consumption', () => {
  arm('C-done', () => true);
  disarm('C-done');
  assert.equal(isArmed('C-done'), false);
  assert.equal(tryConsume('C-done', 'hello'), false);
});

test('disarm is identity-guarded: a stale token must not disarm a newer arm', () => {
  const first = () => true;
  const second = () => true;
  arm('C-overlap', first);
  arm('C-overlap', second);

  disarm('C-overlap', first);
  assert.equal(isArmed('C-overlap'), true, 'the older waiter no longer owns this channel');

  disarm('C-overlap', second);
  assert.equal(isArmed('C-overlap'), false);
});

test('a throwing handler is contained — the message is not swallowed', () => {
  arm('C-buggy', () => { throw new Error('handler blew up'); });
  assert.equal(tryConsume('C-buggy', 'hello'), false, 'not consumed, so it becomes a normal turn');
  assert.equal(isArmed('C-buggy'), true);
});

test('the rehydrator re-arms before a lookup decides (restart with a question still on disk)', () => {
  let restores = 0;
  setHumanAnswerRehydrator(() => {
    restores++;
    arm('C-restored', () => true);
  });

  // Nothing is armed in memory, yet the reply still lands on the waiting question.
  assert.equal(tryConsume('C-restored', 'Use strategy B.'), true);
  assert.equal(restores, 1);
  assert.equal(isArmed('C-restored'), true);
  assert.equal(restores, 2, 'every lookup gives the owner its (idempotent) chance to restore');
});

test('a throwing rehydrator does not break the lookup', () => {
  setHumanAnswerRehydrator(() => { throw new Error('disk gone'); });
  assert.equal(tryConsume('C-anything', 'hello'), false);
  assert.equal(isArmed('C-anything'), false);
});
