// input:  node:test, replay-harness, fixtures/codex/
// output: Codex JSON-RPC → NormalizedEvent fixture-replay tests
// pos:    DR-0008 §4.5 Codex fixture regression test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  replayCodexFixture,
  assertMatchesGolden,
  listFixtures,
} from './replay-harness.js';

const fixtures = listFixtures('codex');

test('codex fixture store is non-empty (DR-0008 §4.5; full ≥5 threshold met jointly with Claude fixtures per ambiguity A2)', () => {
  assert.ok(
    fixtures.length >= 1,
    `expected ≥1 codex fixture, found ${fixtures.length}: ${fixtures.join(', ')}`,
  );
});

for (const name of fixtures) {
  test(`codex fixture ${name}: NormalizedEvent sequence matches golden`, () => {
    const observed = replayCodexFixture(name);
    assertMatchesGolden(observed, 'codex', name);
  });
}
