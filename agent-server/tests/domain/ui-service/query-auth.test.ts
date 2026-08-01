// input:  auth getter, UiService dispatcher, and tRPC router
// output: auth.status passthrough and real registry assertions
// pos:    UI-service authentication status routing regression
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleAuthStatus } from '../../../src/domain/ui-service/query/auth.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
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

test('typed auth.status reaches the real UiService registry once', async () => {
  let calls = 0;
  const deps = {
    getAuthStatus: async () => {
      calls += 1;
      return SNAPSHOT;
    },
  } as unknown as UiServiceDeps;
  const caller = createAppRouter(createUiService(deps)).createCaller({});

  assert.equal(await caller.auth.status({}), SNAPSHOT);
  assert.equal(calls, 1);
});
