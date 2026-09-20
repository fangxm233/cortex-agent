import { describe, expect, it } from 'vitest';
import { characterCount, formatDebugValue } from './DebugDetailsModal';

describe('DEBUG value helpers', () => {
  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(characterCount('A😀中')).toBe(3);
  });

  it('formats structured values as readable JSON', () => {
    expect(formatDebugValue({ a: 1, nested: { keep: true } })).toBe(
      '{\n  "a": 1,\n  "nested": {\n    "keep": true\n  }\n}',
    );
  });
});
