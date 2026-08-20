// input:  Vitest and cli-utils formatError
// output: formatError regression tests
// pos:    Verify shared CLI error rendering behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatError } from '../src/core/cli-utils.js';

test('formatError includes valid values and hint when provided', () => {
  const msg1 = formatError('invalid status: foo');
  assert.equal(msg1, 'invalid status: foo');

  const msg2 = formatError('invalid status: foo', { validValues: ['open', 'closed'] });
  assert.match(msg2, /Valid values: open, closed/);

  const msg3 = formatError('missing flag', { hint: 'Try --help' });
  assert.match(msg3, /Hint: Try --help/);

  const msg4 = formatError('bad input', { validValues: ['a', 'b'], hint: 'See docs' });
  assert.match(msg4, /Valid values: a, b/);
  assert.match(msg4, /Hint: See docs/);
});

