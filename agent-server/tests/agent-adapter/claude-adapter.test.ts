import { test } from 'vitest';

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
}
