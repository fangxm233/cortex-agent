// input:  orch/superseded-edits.ts
// output: regression tests — mark/check/clear lifecycle + edit-cancel race [S6-B]
// pos:    verifies SupersededEdits state transitions and idempotent clear

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { supersededEdits } from '../../src/orchestration/superseded-edits.js';

// Each test uses a unique channel to avoid cross-test state bleed.
let _seq = 0;
function freshChannel() { return `edit-ch-${++_seq}`; }

// ── (a) mark / check / clear lifecycle ───────────────────────────────────────

test('mark → check returns true → clear → check returns false', () => {
  const ch = freshChannel();

  assert.equal(supersededEdits.check(ch), false, 'initially not marked');

  supersededEdits.mark(ch);
  assert.equal(supersededEdits.check(ch), true, 'marked after mark()');

  const cleared = supersededEdits.clear(ch);
  assert.equal(cleared, true, 'clear() returns true when entry existed');
  assert.equal(supersededEdits.check(ch), false, 'no longer marked after clear()');
});

// ── (b) idempotent clear ─────────────────────────────────────────────────────

test('double-clear returns false on second call (idempotent)', () => {
  const ch = freshChannel();

  supersededEdits.mark(ch);
  supersededEdits.clear(ch);
  const secondClear = supersededEdits.clear(ch);
  assert.equal(secondClear, false, 'second clear() on unmarked channel returns false');
});

// ── (c) edit-cancel race simulation ──────────────────────────────────────────

test('edit-cancel race — mark before supersede, check+clear in error handler', () => {
  const ch = freshChannel();

  // Simulate edit-handler path: mark BEFORE killing the agent
  supersededEdits.mark(ch);

  // Simulate agent-lifecycle handleAgentError receiving error.cancelled = true
  const wasCancelled = true;
  const isSuperseded = supersededEdits.check(ch);
  if (wasCancelled && isSuperseded) {
    supersededEdits.clear(ch);
  }

  assert.equal(isSuperseded, true, 'error handler saw superseded flag');
  assert.equal(supersededEdits.check(ch), false, 'flag cleared after handling');
});

// ── (d) independent channels do not interfere ────────────────────────────────

test('marking one channel does not affect another', () => {
  const ch1 = freshChannel();
  const ch2 = freshChannel();

  supersededEdits.mark(ch1);

  assert.equal(supersededEdits.check(ch1), true);
  assert.equal(supersededEdits.check(ch2), false, 'ch2 unaffected by mark on ch1');

  supersededEdits.clear(ch1);
});
