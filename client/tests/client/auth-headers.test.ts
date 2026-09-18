import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientToken, buildClientHeaders } from '../../src/auth-headers.js';

test('resolveClientToken prefers env CORTEX_CLIENT_TOKEN over config', () => {
  assert.equal(
    resolveClientToken({ clientToken: 'from-config' }, { CORTEX_CLIENT_TOKEN: 'from-env' }),
    'from-env',
  );
});

test('resolveClientToken falls back to config clientToken when env is unset', () => {
  assert.equal(resolveClientToken({ clientToken: 'from-config' }, {}), 'from-config');
});

test('resolveClientToken trims and treats blank as empty', () => {
  assert.equal(resolveClientToken({ clientToken: '  cfgtok  ' }, {}), 'cfgtok');
  assert.equal(resolveClientToken({ clientToken: '   ' }, { CORTEX_CLIENT_TOKEN: '  ' }), '');
});

test('buildClientHeaders returns the x-cortex-token header for a non-empty token', () => {
  assert.deepEqual(buildClientHeaders('tok123'), { 'x-cortex-token': 'tok123' });
});

test('buildClientHeaders returns undefined for an empty/blank token', () => {
  assert.equal(buildClientHeaders(''), undefined);
  assert.equal(buildClientHeaders('   '), undefined);
});
