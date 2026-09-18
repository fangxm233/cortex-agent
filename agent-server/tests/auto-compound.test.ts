import { test } from 'vitest';
import assert from 'node:assert/strict';
import { shouldAutoRunCompound } from '../src/domain/threads/auto-thread.js';

test('shouldAutoRunCompound skips self-recursive compound runs', () => {
  assert.equal(shouldAutoRunCompound('/compound-simple'), false);
  assert.equal(shouldAutoRunCompound('please run /compound-simple now'), false);
});

test('shouldAutoRunCompound allows normal scheduled or dispatched tasks', () => {
  assert.equal(shouldAutoRunCompound('check project status'), true);
  assert.equal(shouldAutoRunCompound('/orient-project then implement task'), true);
});
