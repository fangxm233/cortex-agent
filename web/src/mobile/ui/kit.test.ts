// input:  sheet drag metrics and composer text
// output: dismiss decisions and Unicode-safe composer counts
// pos:    Pure mobile UI-kit logic tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import {
  composerCharCount,
  composerCountLabel,
  composerLineCount,
  shouldFlingClose,
} from './kit';

describe('shouldFlingClose', () => {
  it('closes after crossing the distance threshold', () => {
    expect(shouldFlingClose(83, 300, 0.1)).toBe(false);
    expect(shouldFlingClose(85, 300, 0.1)).toBe(true);
  });

  it('closes on a fast downward flick regardless of distance', () => {
    expect(shouldFlingClose(20, 300, 0.9)).toBe(true);
  });

  it('keeps a short, slow drag open', () => {
    expect(shouldFlingClose(20, 300, 0.4)).toBe(false);
  });
});

describe('composer text metrics', () => {
  it('counts newline-separated rows, including a trailing empty row', () => {
    expect(composerLineCount('')).toBe(1);
    expect(composerLineCount('a\nb\n')).toBe(3);
  });

  it('counts Unicode code points and includes newlines', () => {
    expect(composerCharCount('A😀\n中')).toBe(4);
  });

  it('formats counts with caller-provided units', () => {
    expect(composerCountLabel('a\nb', 'rows', 'chars')).toBe('2 rows · 3 chars');
  });
});
