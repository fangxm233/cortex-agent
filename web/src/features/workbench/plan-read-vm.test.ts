import { describe, it, expect } from 'vitest';
import { readProgressPct } from './plan-read-vm';

// Pure logic for the 6b plan reading page (scheme-mobile sec-6). Neutral fixtures.

describe('readProgressPct', () => {
  it('is 100 when the content does not overflow', () => {
    expect(readProgressPct(0, 800, 700)).toBe(100);
    expect(readProgressPct(0, 800, 800)).toBe(100);
  });
  it('tracks the furthest-seen bottom edge as a percentage, clamped 0..100', () => {
    expect(readProgressPct(0, 400, 1000)).toBe(40);
    expect(readProgressPct(220, 400, 1000)).toBe(62);
    expect(readProgressPct(600, 400, 1000)).toBe(100);
    expect(readProgressPct(9999, 400, 1000)).toBe(100);
  });
});
