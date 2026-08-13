// input:  settled execution outcomes
// output: terminal classification precedence tests
// pos:    Pins which terminal reason a failed run is recorded under
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classify, type ExecutionOutcome } from '../../../src/domain/agent-run/runner.js';

function outcome(overrides: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  return {
    result: null, error: null, childExit: null, supervisorExit: null,
    quiescent: true, cancelled: false, ...overrides,
  };
}

function providerFailure(code: number | null): ExecutionOutcome {
  return outcome({
    error: Object.assign(new Error('Connection error.'), { reason: 'provider_error' }),
    childExit: { code, signal: null },
  });
}

test('a run that exhausted its provider retries is not a blanket child failure', () => {
  // The 2026-08-13 paid trial recorded exactly this shape and was filed as `child_failure`,
  // which cannot be told apart from the agent crashing on its own work.
  assert.deepEqual(
    classify(providerFailure(1)),
    { reason: 'provider_error', state: 'failed', exitCode: 1 },
  );
});

test('a provider failure still reports the exit code the child actually used', () => {
  assert.equal(classify(providerFailure(7)).exitCode, 7);
});

test('an ordinary non-zero exit stays a child failure', () => {
  assert.deepEqual(
    classify(outcome({ childExit: { code: 3, signal: null } })),
    { reason: 'child_failure', state: 'failed', exitCode: 3 },
  );
});

test('containment outranks a provider failure', () => {
  // A run that left descendants behind is a containment problem whatever ended the turn.
  const classified = classify({ ...providerFailure(1), quiescent: false });

  assert.equal(classified.reason, 'containment_failure');
});

test('cancellation outranks a provider failure', () => {
  const classified = classify({ ...providerFailure(1), cancelled: true });

  assert.equal(classified.state, 'cancelled');
});

test('a trajectory write failure outranks a provider failure', () => {
  const classified = classify(outcome({
    error: Object.assign(new Error('write'), { reason: 'trajectory_write_failed' }),
    childExit: { code: 1, signal: null },
  }));

  assert.equal(classified.reason, 'trajectory_write_failed');
});

test('a clean run is still completed', () => {
  assert.deepEqual(
    classify(outcome({ childExit: { code: 0, signal: null } })),
    { reason: 'ok', state: 'completed', exitCode: 0 },
  );
});
