import { describe, expect, it } from 'vitest';
import { shouldFlingClose } from './BottomSheet';

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
