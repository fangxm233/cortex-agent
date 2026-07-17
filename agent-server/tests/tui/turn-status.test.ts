// input:  src/tui/turn-status.js
// output: Unit tests for parsing/formatting the dedicated turn-status line
// pos:    Guards the status-text → {state,time,turns,cost} extraction

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseTurnStatus, formatTurnStatus } from '../../src/tui/turn-status.js';

test('parses the sealed "Done" line (time/turns/cost from the metrics group)', () => {
  const s = parseTurnStatus('✅ Done | cortex-6cf48e · `a47dc661` | (4s · 1 turns · $0.0993)');
  assert.equal(s.state, '✅ Done');
  assert.equal(s.time, '4s');
  assert.equal(s.turns, 1);
  assert.equal(s.cost, '0.0993');
  assert.equal(formatTurnStatus(s), '✅ Done · 4s · 1 turns · $0.0993');
});

test('parses the processing line (stopwatch time, turns, no cost)', () => {
  const s = parseTurnStatus('⏳ Processing | cortex-x · `id` | claude/sonnet | ⏱️ 2s | 🔁 3 turns');
  assert.equal(s.state, '⏳ Processing');
  assert.equal(s.time, '2s');
  assert.equal(s.turns, 3);
  assert.equal(s.cost, null);
  assert.equal(formatTurnStatus(s), '⏳ Processing · 2s · 3 turns');
});

test('processing line without turns', () => {
  const s = parseTurnStatus('⏳ Processing | cortex-x · `id` | write | ⏱️ 1s');
  assert.equal(s.state, '⏳ Processing');
  assert.equal(s.time, '1s');
  assert.equal(s.turns, null);
  assert.equal(formatTurnStatus(s), '⏳ Processing · 1s');
});

test('error line keeps state + elapsed', () => {
  const s = parseTurnStatus('❌ Error | cortex-x · `id` | (1s · 0 turns · $0.0000)');
  assert.equal(s.state, '❌ Error');
  assert.equal(s.time, '1s');
  assert.equal(s.turns, 0);
  assert.equal(s.cost, '0.0000');
});
