// input:  available row width, measured chip widths, overflow width
// output: visible/hidden tool-call count assertions
// pos:    Pure collapsed tool-call overflow layout tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { toolCallOverflowLayout, toolCallOverflowText } from './tool-call-overflow';

const layout = (availableWidth: number) => toolCallOverflowLayout({
  availableWidth,
  chipWidths: [30, 40, 50],
  overflowWidth: 20,
  gap: 7,
});

describe('toolCallOverflowLayout', () => {
  it('shows every chip without a suffix when the row fits', () => {
    expect(layout(134)).toEqual({ visibleCount: 3, hiddenCount: 0 });
  });

  it('reserves the suffix and keeps the largest fitting prefix', () => {
    expect(layout(104)).toEqual({ visibleCount: 2, hiddenCount: 1 });
    expect(layout(103)).toEqual({ visibleCount: 1, hiddenCount: 2 });
  });

  it('shows only the suffix when no chip fits beside it', () => {
    expect(layout(20)).toEqual({ visibleCount: 0, hiddenCount: 3 });
  });

  it('returns an empty layout for an empty call group', () => {
    expect(toolCallOverflowLayout({
      availableWidth: 20,
      chipWidths: [],
      overflowWidth: 20,
      gap: 7,
    })).toEqual({ visibleCount: 0, hiddenCount: 0 });
  });

  it('formats the suffix as a plus sign and digits only', () => {
    expect(toolCallOverflowText(12)).toBe('+12');
    expect(toolCallOverflowText(0)).toBeNull();
  });
});
