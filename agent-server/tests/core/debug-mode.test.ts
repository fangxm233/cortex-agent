// input:  DEBUG env maps plus complete tool inputs/results
// output: gate, threshold parsing, character count, and warning tests
// pos:    specifies process-wide DEBUG behavior and large-tool policy
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEBUG_TOOL_WARNING_CHARS,
  debugToolCharacterCount,
  debugToolWarningChars,
  isDebugMode,
  isDebugToolOverWarningThreshold,
} from '../../src/core/debug-mode.js';

test('isDebugMode follows the existing non-empty DEBUG environment contract', () => {
  assert.equal(isDebugMode({}), false);
  assert.equal(isDebugMode({ DEBUG: '' }), false);
  assert.equal(isDebugMode({ DEBUG: '1' }), true);
  assert.equal(isDebugMode({ DEBUG: 'true' }), true);
  assert.equal(isDebugMode({ DEBUG: '0' }), true, 'matches the former Boolean(process.env.DEBUG) logging gate');
});

test('debug tool warning threshold accepts positive safe integers and otherwise defaults', () => {
  assert.equal(debugToolWarningChars({}), DEFAULT_DEBUG_TOOL_WARNING_CHARS);
  assert.equal(debugToolWarningChars({ CORTEX_DEBUG_TOOL_WARNING_CHARS: '25000' }), 25_000);
  for (const raw of ['', '0', '-1', '1.5', 'nope', '9007199254740992']) {
    assert.equal(debugToolWarningChars({ CORTEX_DEBUG_TOOL_WARNING_CHARS: raw }), DEFAULT_DEBUG_TOOL_WARNING_CHARS);
  }
});

test('debug tool character count matches displayed pretty JSON plus result Unicode code points', () => {
  const toolInput = { command: 'echo 😀', nested: { keep: true } };
  const formatted = JSON.stringify(toolInput, null, 2);
  const expected = Array.from(formatted).length + Array.from('结果').length;
  assert.equal(debugToolCharacterCount({ toolInput, toolResult: { content: '结果', isError: false } }), expected);
});

test('debug tool warning is strict greater-than at the configured threshold', () => {
  const env = { CORTEX_DEBUG_TOOL_WARNING_CHARS: '10000' };
  assert.equal(isDebugToolOverWarningThreshold({ toolInput: 'x'.repeat(9_999) }, env), false);
  assert.equal(isDebugToolOverWarningThreshold({ toolInput: 'x'.repeat(10_000) }, env), false);
  assert.equal(isDebugToolOverWarningThreshold({ toolInput: 'x'.repeat(10_001) }, env), true);
});
