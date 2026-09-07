// input:  vitest, replay-harness, fixtures/pi/
// output: PI session event → NormalizedEvent sequence fixture-replay tests
// pos:    PI fixture regression test
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
