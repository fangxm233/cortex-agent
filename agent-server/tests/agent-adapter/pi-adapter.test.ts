// input:  node:test, replay-harness, fixtures/pi/
// output: PI rpc → NormalizedEvent sequence fixture-replay tests
// pos:    DR-0008 §4.5 PI fixture regression test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';

import {
  replayPiFixture,
  assertMatchesGolden,
  listFixtures,
} from './replay-harness.js';

const fixtures = listFixtures('pi');

for (const name of fixtures) {
  test(`pi fixture ${name}: NormalizedEvent sequence matches golden`, () => {
    const observed = replayPiFixture(name);
    assertMatchesGolden(observed, 'pi', name);
  });
}
