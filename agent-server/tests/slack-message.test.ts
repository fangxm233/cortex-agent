import { test } from 'vitest';
import assert from 'node:assert/strict';
import { _test as claudeTest } from '../src/agent-adapter/claude/adapter.js';
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
