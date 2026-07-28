// input:  job registry dispatch callbacks
// output: missing-runner and failure-isolation tests
// pos:    Verifies scheduled job dispatch behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { register, dispatch } from '../src/domain/scheduling/job-registry.js';

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
