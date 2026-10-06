import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatDuration } from '../../src/core/format-duration.js';

test('formatDuration renders the two largest units and drops a zero second unit', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(5 * 60_000), '5m');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(5_400_000), '1h 30m');
  assert.equal(formatDuration(22_320_000), '6h 12m');
  assert.equal(formatDuration(86_400_000), '1d');
  assert.equal(formatDuration(200_000_000), '2d 7h');
});

test('formatDuration says unknown for nonsense rather than printing NaN', () => {
  assert.equal(formatDuration(-1), 'unknown');
  assert.equal(formatDuration(Number.NaN), 'unknown');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), 'unknown');
});
