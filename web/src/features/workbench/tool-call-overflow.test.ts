import { describe, expect, it } from 'vitest';
import { toolCallOverflowLayout } from './tool-call-overflow';

describe('toolCallOverflowLayout', () => {
  it('counts unmeasured calls as hidden behind the suffix', () => {
    expect(toolCallOverflowLayout({
      availableWidth: 300,
      chipWidths: [40, 40, 40],
      overflowWidth: 35,
      gap: 7,
      totalCount: 2_192,
    })).toEqual({ visibleCount: 3, hiddenCount: 2_189 });
  });

  it('omits the suffix when every call fits', () => {
    expect(toolCallOverflowLayout({
      availableWidth: 300,
      chipWidths: [40, 40],
      overflowWidth: 35,
      gap: 7,
    })).toEqual({ visibleCount: 2, hiddenCount: 0 });
  });
});
