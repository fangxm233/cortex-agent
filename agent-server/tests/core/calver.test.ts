import { test } from 'vitest';
import assert from 'node:assert/strict';
import { compareCalVer } from '../../src/core/calver.js';

test('compareCalVer - same version returns 0', () => {
  assert.equal(compareCalVer('2026.5.23', '2026.5.23'), 0);
  assert.equal(compareCalVer('2027.1.1', '2027.1.1'), 0);
});

test('compareCalVer - cross-digit day boundary', () => {
  assert.ok(compareCalVer('2026.5.9', '2026.5.10') < 0, '9 < 10');
  assert.ok(compareCalVer('2026.5.10', '2026.5.9') > 0, '10 > 9');
  assert.ok(compareCalVer('2026.5.23', '2026.5.9') > 0, '23 > 9');
});

test('compareCalVer - cross-digit month boundary', () => {
  assert.ok(compareCalVer('2026.10.1', '2026.5.1') > 0, 'October > May');
  assert.ok(compareCalVer('2026.5.1', '2026.10.1') < 0, 'May < October');
});

test('compareCalVer - different year', () => {
  assert.ok(compareCalVer('2027.1.1', '2026.12.31') > 0, '2027 > 2026');
  assert.ok(compareCalVer('2026.12.31', '2027.1.1') < 0, '2026 < 2027');
});

test('compareCalVer - zero version', () => {
  assert.ok(compareCalVer('2026.5.23', '0.0.0') > 0, 'any version > 0.0.0');
  assert.ok(compareCalVer('0.0.0', '2026.5.23') < 0, '0.0.0 < any version');
});

test('compareCalVer - hotfix suffix sorts above the plain version', () => {
  assert.ok(compareCalVer('2026.5.23-2', '2026.5.23-1') > 0, '-2 > -1');
  assert.ok(compareCalVer('2026.5.23-1', '2026.5.23-2') < 0, '-1 < -2');
  assert.ok(compareCalVer('2026.5.23-1', '2026.5.23') > 0, '-1 > absent');
  assert.ok(compareCalVer('2026.5.23', '2026.5.23-1') < 0, 'absent < -1');
  assert.ok(compareCalVer('2026.5.24', '2026.5.23-9') > 0, 'next day > any hotfix');
});
