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
