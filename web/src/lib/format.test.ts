// input:  representative USD amounts, binary byte boundaries, and precision strategies
// output: regression coverage for canonical shared number labels
// pos:    Unit tests for lib/format
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { formatBytes, formatUsd } from './format';

describe('formatUsd', () => {
  it('always renders exactly two fraction digits', () => {
    expect(formatUsd(4)).toBe('$4.00');
    expect(formatUsd(4.2)).toBe('$4.20');
    expect(formatUsd(4.236)).toBe('$4.24');
  });
});

describe('formatBytes', () => {
  it('selects binary units and leaves byte values unscaled', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('supports each feature precision strategy', () => {
    expect(formatBytes(1536, { fractionDigits: 0 })).toBe('2 KB');
    expect(formatBytes(1024, { fractionDigits: 1 })).toBe('1.0 KB');
    expect(formatBytes(1024, { fractionDigits: 1, trimTrailingZeros: true })).toBe('1 KB');
    expect(formatBytes(1536, { fractionDigits: 1, trimTrailingZeros: true })).toBe('1.5 KB');
    expect(formatBytes(1024 ** 3, { fractionDigits: 1, maxUnit: 'MB' })).toBe('1024.0 MB');
  });
});
