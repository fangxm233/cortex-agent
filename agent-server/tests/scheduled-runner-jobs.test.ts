// input:  job-registry + all 5 job modules
// output: registration completeness + dispatch error isolation
// pos:    S9 job-registry contract tests
// >>> If I am updated, also update src/domain/scheduling/CORTEX.md (if exists) <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

// Static import — shares canonical ESM cache with dynamic imports below,
// so job modules' register() calls mutate the same _registry Map.
import { registeredKeys, register, dispatch } from '../src/domain/scheduling/job-registry.js';

test('all 5 job keys registered after importing job modules', async () => {
  // Dynamically import the scheduled-runner — it transitively imports all 5 job
  // modules, each of which calls register() at module-evaluation time. Since
  // job-registry is already in the ESM cache (via static import), all register()
  // calls go to the same _registry Map that registeredKeys() reads from.
  await import('../src/domain/scheduling/runner.js');

  const keys = registeredKeys();
  assert.ok(keys.includes('scheduled-task'), 'scheduled-task registered');
  assert.ok(keys.includes('task-dispatch'), 'task-dispatch registered');
  assert.ok(keys.includes('memory-index-regen'), 'memory-index-regen registered');
  assert.ok(keys.includes('task-archive'), 'task-archive registered');
  assert.ok(keys.includes('sync-public'), 'sync-public registered');
  assert.equal(keys.length, 5, 'exactly 5 keys registered');
});

test('unknown key dispatch logs a warning and returns false', () => {
  const result = dispatch('nonexistent-key', {});
  assert.equal(result, false, 'dispatch returns false for unknown key');
});

test('one job failure does not break dispatch table', async () => {
  // Register a throwing runner
  const failKey = 'throwing-job';
  let failureCaught = false;
  register(failKey, async () => {
    throw new Error('simulated failure');
  });

  // Register a succeeding runner
  const successKey = 'succeeding-job';
  let successCalled = false;
  register(successKey, async () => {
    successCalled = true;
  });

  // Dispatch the throwing runner — should log error but not throw
  const throwResult = dispatch(failKey, {});
  assert.equal(throwResult, true, 'dispatch for known key returns true');

  // Give the promise a cycle to reject and be caught
  await new Promise(r => setTimeout(r, 50));

  // Dispatch the succeeding runner — should still work
  const successResult = dispatch(successKey, {});
  assert.equal(successResult, true, 'dispatch succeeds after previous failure');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(successCalled, true, 'succeeding runner was called');
});
