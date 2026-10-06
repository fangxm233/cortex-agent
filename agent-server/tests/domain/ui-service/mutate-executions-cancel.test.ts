import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCancelExecution } from '../../../src/domain/ui-service/mutate/executions.js';
import { makeUiDeps } from './ui-deps-fixture.js';

test('executions.cancel kills a live execution through the live cancel path', async () => {
  const live: string[] = [];
  const repoCancels: string[] = [];
  const deps = makeUiDeps({
    cancelLiveExecution: async (id) => { live.push(id); return true; },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: (id) => { repoCancels.push(id); return null; } },
  });
  const res = await handleCancelExecution(deps, { executionId: 'exec-1' });
  assert.deepEqual(res, { ok: true, data: { cancelled: true } });
  assert.deepEqual(live, ['exec-1']);
  assert.deepEqual(repoCancels, [], 'the live path already finalizes the record');
});

test('executions.cancel without a live handle finalizes the record only', async () => {
  const repoCancels: string[] = [];
  const deps = makeUiDeps({
    cancelLiveExecution: async () => false,
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: (id) => { repoCancels.push(id); return { id } as any; } },
  });
  const res = await handleCancelExecution(deps, { executionId: 'exec-2' });
  assert.deepEqual(res, { ok: true, data: { cancelled: true } });
  assert.deepEqual(repoCancels, ['exec-2']);
});

test('executions.cancel of an unknown execution is not-found', async () => {
  const deps = makeUiDeps({ cancelLiveExecution: async () => false });
  const res = await handleCancelExecution(deps, { executionId: 'ghost' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
});
