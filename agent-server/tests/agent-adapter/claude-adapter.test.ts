import { test } from 'vitest';

import {
  replayClaudeFixture,
  assertMatchesGolden,
  listFixtures,
} from './replay-harness.js';

const fixtures = listFixtures('claude');

for (const name of fixtures) {
  test(`claude fixture ${name}: production NormalizedEvent sequence matches golden`, async () => {
    const observed = await replayClaudeFixture(name);
    assertMatchesGolden(observed, 'claude', name);
  });
}
