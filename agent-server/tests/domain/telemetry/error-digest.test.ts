import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { createLogger, setErrorLogSink } from '@core/log.js';
import { INSTALL_ROOT } from '@core/paths.js';
import { describeLogError, recordErrorLog } from '@domain/telemetry/error-digest.js';
import { configureRollupStore, persistRollup } from '@domain/telemetry/rollup.js';
import { rollupFile } from '@domain/telemetry/paths.js';
import { enableTelemetryForTest } from './helpers.js';

let restore: () => void = () => {};
let dir = '';
const NOW = Date.parse('2026-10-01T12:00:00Z');
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'telemetry-digest-'));
  configureRollupStore({ dir, now: () => NOW });
});
afterEach(() => {
  setErrorLogSink(null);
  configureRollupStore({});
  restore();
});

function stored() {
  persistRollup();
  return JSON.parse(readFileSync(rollupFile('2026-10-01', dir), 'utf8'));
}

test('log.error calls are counted per module with up to five redacted samples', () => {
  restore = enableTelemetryForTest();
  setErrorLogSink(recordErrorLog);
  const log = createLogger('fsync-test');
  for (let i = 0; i < 3; i += 1) log.error(`fsync failed for ${os.homedir()}/.cortex/data/x${i}.json: EPERM`);
  for (let i = 0; i < 8; i += 1) createLogger('other').error(`distinct failure kind ${'abcdefgh'[i]}`);
  const rollup = stored();
  assert.equal(rollup.errors.byModule['fsync-test'], 3);
  assert.equal(rollup.errors.byModule.other, 8);
  assert.equal(rollup.errors.samples.length, 5);
  const fsync = rollup.errors.samples.find((sample: { module: string }) => sample.module === 'fsync-test');
  assert.equal(fsync.count, 3, 'same shape, one group');
  assert.doesNotMatch(JSON.stringify(rollup.errors), new RegExp(os.homedir()));
});

test('nothing is recorded while telemetry is inactive', () => {
  setErrorLogSink(recordErrorLog);
  createLogger('quiet').error('x');
  persistRollup();
  assert.throws(() => readFileSync(rollupFile('2026-10-01', dir)));
});

test('an Error argument groups by its first Cortex frame', () => {
  const error = new Error('boom');
  error.stack = `Error: boom\n    at load (${INSTALL_ROOT}/dist/store/a.js:1:1)`;
  const { groupKey } = describeLogError('store', ['load failed', error]);
  assert.equal(groupKey, 'store:Error@dist/store/a.js#load');
});
