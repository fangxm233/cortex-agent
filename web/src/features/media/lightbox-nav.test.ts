import { describe, expect, it } from 'vitest';
import { arrowStep, releaseStep, strokeAxis, trackOffset } from './lightbox-nav';

describe('strokeAxis', () => {
  it('stays undecided inside the slop', () => {
    expect(strokeAxis(4, 3)).toBeNull();
  });

  it('locks to the dominant axis once the stroke leaves the slop', () => {
    expect(strokeAxis(-20, 5)).toBe('x');
    expect(strokeAxis(6, 20)).toBe('y');
  });
});

describe('trackOffset', () => {
  it('follows the finger where the group has a neighbour', () => {
    expect(trackOffset(-80, 1, 3)).toBe(-80);
    expect(trackOffset(80, 1, 3)).toBe(80);
  });

  it('resists past either end of the group', () => {
    expect(Math.abs(trackOffset(100, 0, 3))).toBeLessThan(100);
    expect(Math.abs(trackOffset(-100, 2, 3))).toBeLessThan(100);
    expect(trackOffset(-100, 0, 3)).toBe(-100);
  });
});

describe('releaseStep', () => {
  const W = 400;

  it('moves on after a drag past a fifth of the width', () => {
    expect(releaseStep(-100, 0, W, 0, 3)).toBe(1);
    expect(releaseStep(100, 0, W, 1, 3)).toBe(-1);
  });

  it('springs back from a short slow drag', () => {
    expect(releaseStep(-60, -0.1, W, 0, 3)).toBe(0);
  });

  it('moves on after a short quick flick', () => {
    expect(releaseStep(-40, -0.8, W, 0, 3)).toBe(1);
  });

  it('springs back when the release flicks against the drag', () => {
    expect(releaseStep(-150, 0.8, W, 0, 3)).toBe(0);
  });

  it('never steps past either end', () => {
    expect(releaseStep(150, 0, W, 0, 3)).toBe(0);
    expect(releaseStep(-150, 0, W, 2, 3)).toBe(0);
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
