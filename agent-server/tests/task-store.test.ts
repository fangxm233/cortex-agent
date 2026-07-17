// input: Node test runner, assert, task-store re-export → store/task-repo.ts
// output: regression tests for TaskRepo.runExclusive mutex serialization
// pos: Verify taskStore.runExclusive mutex serialization guarantee for external callers (S3 Pattern B migration)
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { taskStore } from '../src/domain/tasks/store.js';

test('taskStore.runExclusive serializes concurrent operations', async () => {
  const order: string[] = [];

  const p1 = taskStore.runExclusive(async () => {
    order.push('start-1');
    await new Promise(r => setTimeout(r, 50));
    order.push('end-1');
    return 'a';
  });

  const p2 = taskStore.runExclusive(async () => {
    order.push('start-2');
    return 'b';
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'a');
  assert.equal(r2, 'b');
  // p2 must not start until p1 finishes
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2']);
});

test('taskStore.runExclusive propagates errors without breaking the mutex', async () => {
  // First call throws
  await assert.rejects(
    () => taskStore.runExclusive(() => { throw new Error('boom'); }),
    { message: 'boom' }
  );

  // Second call should still work (mutex released after error)
  const result = await taskStore.runExclusive(() => 42);
  assert.equal(result, 42);
});
