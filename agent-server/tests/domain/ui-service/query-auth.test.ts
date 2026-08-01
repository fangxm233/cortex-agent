// input:  authentication snapshot getter and UI query handler
// output: auth.status identity and single-read assertions
// pos:    UI-service authentication status query regression test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleAuthStatus } from '../../../src/domain/ui-service/query/auth.js';
import type { AuthStatusSnapshot } from '../../../src/domain/auth/auth-status.js';

const SNAPSHOT: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [],
  piRuntime: { available: false, version: null, entry: null, error: 'pi executable not found' },
};

test('auth.status returns the exact AuthStatusSnapshot from one getter call', async () => {
  let calls = 0;
  const result = await handleAuthStatus({}, async () => {
    calls += 1;
    return SNAPSHOT;
  });

  assert.equal(calls, 1);
  assert.equal(result, SNAPSHOT);
});
