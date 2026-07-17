// input:  Node test runner + auto-compound helpers
// output: compound gating + final-output merge tests
// pos:    Verify auto-compound trigger rules and merging
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { shouldAutoRunCompound, combineFinalOutputs } from '../src/domain/threads/auto-thread.js';

test('shouldAutoRunCompound skips self-recursive compound runs', () => {
  assert.equal(shouldAutoRunCompound('/compound-simple'), false);
  assert.equal(shouldAutoRunCompound('please run /compound-simple now'), false);
});

test('shouldAutoRunCompound allows normal scheduled or dispatched tasks', () => {
  assert.equal(shouldAutoRunCompound('check project status'), true);
  assert.equal(shouldAutoRunCompound('/orient-project then implement task'), true);
});

test('combineFinalOutputs keeps primary output when compound output is empty', () => {
  assert.equal(combineFinalOutputs('main result', ''), 'main result');
  assert.equal(combineFinalOutputs('main result', null), 'main result');
});

test('combineFinalOutputs appends compound output after main output', () => {
  assert.equal(
    combineFinalOutputs('main result', 'compound result'),
    'main result\n\n--- Auto compound ---\ncompound result'
  );
});

test('combineFinalOutputs returns compound output when primary output is empty', () => {
  assert.equal(combineFinalOutputs('', 'compound result'), 'compound result');
});
