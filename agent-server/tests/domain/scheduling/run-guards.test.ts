import { test } from 'vitest';
import assert from 'node:assert/strict';
import { hasRunningExecutionForSchedule, isValidDispatchPrompt } from '../../../src/domain/scheduling/run-guards.js';

test('hasRunningExecutionForSchedule matches running scheduled executions by schedule id', () => {
  const records = [
    { status: 'running', kind: 'scheduled', scheduleTaskId: 'sched-1' },
    { status: 'completed', kind: 'scheduled', scheduleTaskId: 'sched-2' },
  ];

  assert.equal(hasRunningExecutionForSchedule(records, 'sched-1'), true);
  assert.equal(hasRunningExecutionForSchedule(records, 'sched-2'), false);
  assert.equal(hasRunningExecutionForSchedule(records, 'missing'), false);
});

test('isValidDispatchPrompt rejects null/empty/whitespace values', () => {
  assert.equal(isValidDispatchPrompt(null), false);
  assert.equal(isValidDispatchPrompt(undefined), false);
  assert.equal(isValidDispatchPrompt(''), false);
  assert.equal(isValidDispatchPrompt('   '), false);
  assert.equal(isValidDispatchPrompt('\t\n'), false);
  assert.equal(isValidDispatchPrompt('null'), false);
  assert.equal(isValidDispatchPrompt('undefined'), false);
  // Non-string types
  assert.equal(isValidDispatchPrompt(0), false);
  assert.equal(isValidDispatchPrompt(false), false);
  assert.equal(isValidDispatchPrompt([]), false);
});

test('isValidDispatchPrompt accepts valid prompt values', () => {
  assert.equal(isValidDispatchPrompt('Execute /orient fast'), true);
  assert.equal(isValidDispatchPrompt('[Scheduled Task] Execute /orient fast'), true);
  assert.equal(isValidDispatchPrompt('Run experiments'), true);
  assert.equal(isValidDispatchPrompt('true'), true);
  assert.equal(isValidDispatchPrompt('0'), true);
  assert.equal(isValidDispatchPrompt('false'), true);
  assert.equal(isValidDispatchPrompt(' null profile task'), true);  // has real content beyond "null"
  assert.equal(isValidDispatchPrompt('task is null-ish'), true);    // substring, not exact match
});
