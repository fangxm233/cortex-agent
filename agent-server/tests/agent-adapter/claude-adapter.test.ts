// input:  Node test runner + replay-harness + NormalizedEvent
// output: Claude fixture-replay regression tests
// pos:    Lock down Claude stream-json to NormalizedEvent contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  replayClaudeFixture,
  assertMatchesGolden,
  listFixtures,
} from './replay-harness.js';

const fixtures = listFixtures('claude');

for (const name of fixtures) {
  test(`claude fixture ${name}: NormalizedEvent sequence matches golden`, () => {
    const observed = replayClaudeFixture(name);
    assertMatchesGolden(observed, 'claude', name);
  });

  test(`claude fixture ${name}: begins with session_started and ends with turn_complete`, () => {
    const observed = replayClaudeFixture(name);
    assert.ok(observed.length >= 2, 'fixture must have at least session_started + turn_complete');
    assert.equal(observed[0].type, 'session_started', 'first event must be session_started');
    assert.equal(
      observed[observed.length - 1].type,
      'turn_complete',
      'last event must be turn_complete',
    );
  });
}
