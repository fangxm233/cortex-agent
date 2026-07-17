// input:  Node test runner + disk-monitor pure helpers
// output: shouldAlert + formatBytes regression tests
// pos:    Verify disk alert determination and byte formatting
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  shouldAlert, formatBytes,
  WARN_BYTES, HYSTERESIS_BYTES, REALERT_COOLDOWN_MS,
} from '../src/domain/monitor/disk-monitor.js';

const CLEAN_STATE = { hasAlerted: false, lastAlertAt: null };
const NOW = 1_000_000_000_000;

test('shouldAlert: free >= hysteresis clears state and does not alert', () => {
  const { alert, newState } = shouldAlert(HYSTERESIS_BYTES, CLEAN_STATE, NOW);
  assert.equal(alert, false);
  assert.deepEqual(newState, { hasAlerted: false, lastAlertAt: null });
});

test('shouldAlert: free >= hysteresis resets a previously-alerted state', () => {
  const prior = { hasAlerted: true, lastAlertAt: NOW - 1000 };
  const { alert, newState } = shouldAlert(HYSTERESIS_BYTES + 1, prior, NOW);
  assert.equal(alert, false);
  assert.deepEqual(newState, { hasAlerted: false, lastAlertAt: null });
});

test('shouldAlert: free below warn from clean state alerts and records timestamp', () => {
  const { alert, newState } = shouldAlert(WARN_BYTES - 1, CLEAN_STATE, NOW);
  assert.equal(alert, true);
  assert.deepEqual(newState, { hasAlerted: true, lastAlertAt: NOW });
});

test('shouldAlert: free below warn within cooldown does not re-alert', () => {
  const prior = { hasAlerted: true, lastAlertAt: NOW - (REALERT_COOLDOWN_MS - 1) };
  const { alert, newState } = shouldAlert(WARN_BYTES - 1, prior, NOW);
  assert.equal(alert, false);
  assert.deepEqual(newState, prior);
});

test('shouldAlert: free below warn after cooldown re-alerts and updates timestamp', () => {
  const prior = { hasAlerted: true, lastAlertAt: NOW - (REALERT_COOLDOWN_MS + 1) };
  const { alert, newState } = shouldAlert(WARN_BYTES - 1, prior, NOW);
  assert.equal(alert, true);
  assert.deepEqual(newState, { hasAlerted: true, lastAlertAt: NOW });
});

test('shouldAlert: free in gray band (between warn and hysteresis) keeps alerted state without re-alerting', () => {
  const between = (WARN_BYTES + HYSTERESIS_BYTES) / 2;
  const prior = { hasAlerted: true, lastAlertAt: NOW - 1000 };
  const { alert, newState } = shouldAlert(between, prior, NOW);
  assert.equal(alert, false);
  assert.deepEqual(newState, prior);
});

test('shouldAlert: free in gray band from clean state stays clean and silent', () => {
  const between = (WARN_BYTES + HYSTERESIS_BYTES) / 2;
  const { alert, newState } = shouldAlert(between, CLEAN_STATE, NOW);
  assert.equal(alert, false);
  assert.deepEqual(newState, CLEAN_STATE);
});

test('shouldAlert: free at exact warn boundary does not alert (strict <)', () => {
  const { alert } = shouldAlert(WARN_BYTES, CLEAN_STATE, NOW);
  assert.equal(alert, false);
});

test('formatBytes: renders human-readable units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2 * 1024), '2 KB');
  assert.equal(formatBytes(1024 * 1024), '1 MB');
  assert.equal(formatBytes(500 * 1024 * 1024), '500 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
});
