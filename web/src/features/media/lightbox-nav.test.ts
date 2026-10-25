import { describe, expect, it } from 'vitest';
import { arrowStep, swipeStep } from './lightbox-nav';

describe('swipeStep', () => {
  const at = (x: number, y = 0): { x: number; y: number } => ({ x, y });

  it('moves to the next item on a left swipe and the previous on a right swipe', () => {
    expect(swipeStep(at(300), at(200))).toBe(1);
    expect(swipeStep(at(200), at(300))).toBe(-1);
  });

  it('ignores short strokes and mostly vertical ones', () => {
    expect(swipeStep(at(300), at(250))).toBe(0);
    expect(swipeStep(at(300, 0), at(200, 80))).toBe(0);
    expect(swipeStep(at(300, 0), at(200, 60))).toBe(1);
  });
});

describe('arrowStep', () => {
  it('maps the horizontal arrows and nothing else', () => {
    expect(arrowStep('ArrowLeft')).toBe(-1);
    expect(arrowStep('ArrowRight')).toBe(1);
    expect(arrowStep('ArrowUp')).toBe(0);
    expect(arrowStep('Enter')).toBe(0);
  });
});
