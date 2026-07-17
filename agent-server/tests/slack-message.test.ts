// input:  Node test runner + mergeSubstantialOutput
// output: output merge regression tests
// pos:    Verify Claude output merging logic
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { claudeTest } from '../src/domain/agents/index.js';
const { mergeSubstantialOutput } = claudeTest;

// --- mergeSubstantialOutput ---

test('mergeSubstantialOutput: final >= 300 chars — no merge even if longest is bigger', () => {
  const final = 'x'.repeat(300);
  const longest = 'y'.repeat(3000);
  assert.equal(mergeSubstantialOutput(final, longest), final);
});

test('mergeSubstantialOutput: final short + longest much bigger — merge', () => {
  const longest = 'x'.repeat(2923);  // orient briefing
  const final = 'y'.repeat(242);     // epilogue
  const result = mergeSubstantialOutput(final, longest);
  assert.ok(result.startsWith(longest));
  assert.ok(result.includes('---'));
  assert.ok(result.endsWith(final));
});

test('mergeSubstantialOutput: final short but longest only slightly bigger — no merge (ratio >= 0.5)', () => {
  const longest = 'x'.repeat(400);
  const final = 'y'.repeat(250);  // 250/400 = 0.625 > 0.5
  assert.equal(mergeSubstantialOutput(final, longest), final);
});

test('mergeSubstantialOutput: no longest — returns final as-is', () => {
  assert.equal(mergeSubstantialOutput('short', null), 'short');
});

test('mergeSubstantialOutput: final === longest — no merge', () => {
  const text = 'x'.repeat(2000);
  assert.equal(mergeSubstantialOutput(text, text), text);
});

test('mergeSubstantialOutput: real-world 242/2923 case triggers merge', () => {
  const orient = 'A'.repeat(2923);
  const epilogue = 'B'.repeat(242);
  const result = mergeSubstantialOutput(epilogue, orient);
  // 242 < 300 && 242 < 2923*0.5=1461 → merge
  assert.ok(result.includes(orient));
  assert.ok(result.includes(epilogue));
});

test('mergeSubstantialOutput: 410/608 case — no merge (410 >= 300)', () => {
  const summary = 'A'.repeat(608);
  const final = 'B'.repeat(410);
  assert.equal(mergeSubstantialOutput(final, summary), final);
});
