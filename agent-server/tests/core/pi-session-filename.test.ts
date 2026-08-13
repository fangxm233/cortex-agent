// input:  PI transcript filename selector
// output: canonical, exact timestamp-prefixed, and backup-near-miss selection tests
// pos:    guards exact PI filename parsing

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { selectPISessionFilename } from '../../src/core/pi-session-filename.js';

test('selectPISessionFilename prefers the canonical filename', () => {
  const sessionId = '01234567-89ab-7cde-8fab-0123456789ab';
  const filename = selectPISessionFilename([
    `2026-08-01T01-02-03Z_${sessionId}.jsonl`,
    `${sessionId}.jsonl`,
  ], sessionId);
  assert.equal(filename, `${sessionId}.jsonl`);
});

test('selectPISessionFilename accepts only exact timestamp-prefixed matches', () => {
  const sessionId = 'backend-prefixed';
  const filename = selectPISessionFilename([
    `2026-08-01T01-02-03Z_${sessionId}.jsonl`,
    `backup_2026-08-01T01-02-03Z_${sessionId}.jsonl`,
    `2026-08-01T01-02-03Z_${sessionId}.jsonl.turn-7.bak`,
  ], sessionId);
  assert.equal(filename, `2026-08-01T01-02-03Z_${sessionId}.jsonl`);
});

test('selectPISessionFilename ignores backups when a primary transcript is absent', () => {
  const sessionId = 'backend-prefixed';
  const filename = selectPISessionFilename([
    `${sessionId}.jsonl.turn-2.bak`,
    `2026-08-01T01-02-03Z_${sessionId}.jsonl.turn-7.bak`,
  ], sessionId);
  assert.equal(filename, null);
});

test('selectPISessionFilename rejects near-miss canonical and timestamp-prefixed names', () => {
  const sessionId = 'backend-prefixed';
  const filename = selectPISessionFilename([
    `${sessionId}.jsonl.bak`,
    `x${sessionId}.jsonl`,
    `2026-08-01T01-02-03Z-${sessionId}.jsonl`,
    `2026-08-01T01-02-03Z_${sessionId}.jsonl.extra`,
  ], sessionId);
  assert.equal(filename, null);
});

test('selectPISessionFilename returns the newest exact timestamp-prefixed filename', () => {
  const sessionId = 'backend-prefixed';
  const filename = selectPISessionFilename([
    `2026-08-01T01-02-03Z_${sessionId}.jsonl`,
    `2026-08-02T01-02-03Z_${sessionId}.jsonl`,
  ], sessionId);
  assert.equal(filename, `2026-08-02T01-02-03Z_${sessionId}.jsonl`);
});
