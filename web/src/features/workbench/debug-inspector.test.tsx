// input:  DEBUG strings and structured values
// output: Unicode-safe counts and lossless readable formatting
// pos:    Pure DEBUG inspector value tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { characterCount, formatDebugValue } from './DebugDetailsModal';

describe('DEBUG value helpers', () => {
  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(characterCount('A😀中')).toBe(3);
  });

  it('keeps string values verbatim', () => {
    expect(formatDebugValue('a\nb')).toBe('a\nb');
  });

  it('formats structured values as readable JSON', () => {
    expect(formatDebugValue({ a: 1, nested: { keep: true } })).toBe(
      '{\n  "a": 1,\n  "nested": {\n    "keep": true\n  }\n}',
    );
  });
});
