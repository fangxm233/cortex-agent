// input:  task archive age predicate
// output: completion timestamp compatibility regressions
// pos:    Verifies task archive date parsing
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isOlderThan } from '../src/domain/tasks/archiver.js';

test('task archiver accepts precise ISO and legacy completion dates', () => {
  assert.equal(isOlderThan('2000-01-01T23:59:59.000Z', 3), true);
  assert.equal(isOlderThan('2000-01-01', 3), true);
  assert.equal(isOlderThan('2999-01-01T00:00:00.000Z', 3), false);
});
