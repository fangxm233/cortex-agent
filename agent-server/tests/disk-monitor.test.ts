// input:  Vitest, mocked fs/settings, disk-monitor helpers
// output: path, toggle, alert-decision, and formatting regressions
// pos:    Verify disk monitor lifecycle and alert policy
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platform/index.js';
import { DATA_DIR } from '../src/core/paths.js';

const mocks = vi.hoisted(() => ({
  statfs: vi.fn(),
  settings: { diskMonitor: true },
  callbacks: new Set<(changedKeys: string[]) => void>(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, promises: { ...actual.promises, statfs: mocks.statfs } };
});

vi.mock('@core/settings.js', () => ({
  getSettings: () => mocks.settings,
  onSettingsChange: (callback: (changedKeys: string[]) => void) => {
    mocks.callbacks.add(callback);
    return () => mocks.callbacks.delete(callback);
  },
}));

import {
  shouldAlert, formatBytes, checkDiskOnce, initDiskMonitor,
  WARN_BYTES, HYSTERESIS_BYTES, REALERT_COOLDOWN_MS,
  _testReset,
} from '../src/domain/monitor/disk-monitor.js';

const CLEAN_STATE = { hasAlerted: false, lastAlertAt: null };
const NOW = 1_000_000_000_000;
const HIGH_SPACE_STAT = { bsize: 4096, bavail: (2 * 1024 * 1024 * 1024) / 4096 };

beforeEach(() => {
  mocks.settings.diskMonitor = true;
  mocks.callbacks.clear();
  mocks.statfs.mockReset();
  mocks.statfs.mockResolvedValue(HIGH_SPACE_STAT);
});

afterEach(() => {
  _testReset();
  vi.useRealTimers();
});

test('checkDiskOnce checks the filesystem that contains Cortex DATA_DIR', async () => {
  mocks.statfs.mockResolvedValue(HIGH_SPACE_STAT);

  await checkDiskOnce();

  assert.equal(mocks.statfs.mock.calls.length, 1);
  assert.equal(mocks.statfs.mock.calls[0][0], DATA_DIR);
});

test('checkDiskOnce skips statfs while disk monitoring is disabled', async () => {
  mocks.settings.diskMonitor = false;

  await checkDiskOnce();

  assert.equal(mocks.statfs.mock.calls.length, 0);
});

test('disk monitor hot toggle stops checks and re-enables with an immediate check', async () => {
  vi.useFakeTimers();
  mocks.settings.diskMonitor = false;
  initDiskMonitor({} as PlatformAdapter, 1_000);
  assert.equal(mocks.statfs.mock.calls.length, 0);

  mocks.settings.diskMonitor = true;
  for (const callback of mocks.callbacks) callback(['diskMonitor']);
  assert.equal(mocks.statfs.mock.calls.length, 1);

  mocks.settings.diskMonitor = false;
  for (const callback of mocks.callbacks) callback(['diskMonitor']);
  await vi.advanceTimersByTimeAsync(2_000);
  assert.equal(mocks.statfs.mock.calls.length, 1);

  mocks.settings.diskMonitor = true;
  for (const callback of mocks.callbacks) callback(['diskMonitor']);
  assert.equal(mocks.statfs.mock.calls.length, 2);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(mocks.statfs.mock.calls.length, 3);
});

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
