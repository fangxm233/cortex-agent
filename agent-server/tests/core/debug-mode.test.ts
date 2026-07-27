// input:  process-style environment maps and core/debug-mode
// output: unit coverage for the process-wide DEBUG truthiness contract
// pos:    keeps logging, transcript capture, and DTO exposure behind one shared gate
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isDebugMode } from '../../src/core/debug-mode.js';

test('isDebugMode follows the existing non-empty DEBUG environment contract', () => {
  assert.equal(isDebugMode({}), false);
  assert.equal(isDebugMode({ DEBUG: '' }), false);
  assert.equal(isDebugMode({ DEBUG: '1' }), true);
  assert.equal(isDebugMode({ DEBUG: 'true' }), true);
  assert.equal(isDebugMode({ DEBUG: '0' }), true, 'matches the former Boolean(process.env.DEBUG) logging gate');
});
