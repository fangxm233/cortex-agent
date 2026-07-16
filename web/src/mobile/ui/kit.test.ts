import { describe, it, expect } from 'vitest';
import { shouldFlingClose } from './kit';

// MBottomSheet drag-to-dismiss threshold (the grab handle is a live drag target): a released drag
// flings the sheet closed past ~28% of its height, or on a fast downward flick regardless of distance.
describe('shouldFlingClose', () => {
  const H = 300; // 28% ≈ 84px

  it('snaps back for a small, slow drag', () => {
    expect(shouldFlingClose(40, H, 0)).toBe(false);
    expect(shouldFlingClose(83, H, 0.1)).toBe(false);
  });

  it('closes once dragged past ~28% of the sheet height', () => {
    expect(shouldFlingClose(85, H, 0)).toBe(true);
    expect(shouldFlingClose(200, H, 0)).toBe(true);
  });

  it('closes on a fast downward flick even when the distance is short', () => {
    expect(shouldFlingClose(20, H, 0.9)).toBe(true);
  });

  it('does not close on a gentle flick below the velocity threshold', () => {
    expect(shouldFlingClose(20, H, 0.4)).toBe(false);
  });
});
