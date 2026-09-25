import { describe, expect, it } from 'vitest';
import { RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MAX, RAIL_WIDTH_MIN, clampRailWidth, parseRailWidth } from './rail-width';

describe('rail width', () => {
  it('clamps into the band and rounds to whole pixels', () => {
    expect(clampRailWidth(100)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(9999)).toBe(RAIL_WIDTH_MAX);
    expect(clampRailWidth(333.6)).toBe(334);
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('falls back to the default for a missing or broken stored value', () => {
    expect(parseRailWidth(null)).toBe(RAIL_WIDTH_DEFAULT);
    expect(parseRailWidth('')).toBe(RAIL_WIDTH_DEFAULT);
    expect(parseRailWidth('wide')).toBe(RAIL_WIDTH_DEFAULT);
    expect(parseRailWidth('360')).toBe(360);
    expect(parseRailWidth('50')).toBe(RAIL_WIDTH_MIN);
  });
});
