// input:  stored dock/split values and divider drag geometry
// output: regressions for the dock's width band and drag arithmetic
// pos:    Unit tests for the dock geometry model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  clampDockSplit,
  parseDockOpen,
  parseDockSplit,
  splitFromDrag,
  DOCK_SPLIT_DEFAULT,
  DOCK_SPLIT_MAX,
  DOCK_SPLIT_MIN,
} from './dock-split';

describe('clampDockSplit', () => {
  it('keeps a ratio inside the allowed band', () => {
    expect(clampDockSplit(0.5)).toBe(0.5);
    expect(clampDockSplit(0.4)).toBe(0.4);
  });
  it('clamps below/above the band to its edges', () => {
    expect(clampDockSplit(0.01)).toBe(DOCK_SPLIT_MIN);
    expect(clampDockSplit(0.99)).toBe(DOCK_SPLIT_MAX);
  });
  it('falls back to the default for non-finite input', () => {
    expect(clampDockSplit(Number.NaN)).toBe(DOCK_SPLIT_DEFAULT);
    expect(clampDockSplit(Number.POSITIVE_INFINITY)).toBe(DOCK_SPLIT_DEFAULT);
  });
});

describe('parseDockSplit', () => {
  it('reads a stored ratio', () => {
    expect(parseDockSplit('0.42')).toBe(0.42);
  });
  it('defaults on a missing / unparseable value', () => {
    expect(parseDockSplit(null)).toBe(DOCK_SPLIT_DEFAULT);
    expect(parseDockSplit('')).toBe(DOCK_SPLIT_DEFAULT);
    expect(parseDockSplit('wide')).toBe(DOCK_SPLIT_DEFAULT);
  });
  it('clamps an out-of-band stored ratio', () => {
    expect(parseDockSplit('0.98')).toBe(DOCK_SPLIT_MAX);
  });
});

describe('parseDockOpen', () => {
  it('only "1" restores the docked mode', () => {
    expect(parseDockOpen('1')).toBe(true);
    expect(parseDockOpen('0')).toBe(false);
    expect(parseDockOpen(null)).toBe(false);
    expect(parseDockOpen('true')).toBe(false);
  });
});

describe('splitFromDrag', () => {
  // The divider sits on the LEFT edge of the dock pane: dragging it left widens the dock.
  it('derives the dock share from the pointer inside the region', () => {
    // region x∈[300,1300); pointer at 800 → the dock takes the right half.
    expect(splitFromDrag(300, 1000, 800)).toBeCloseTo(0.5, 5);
  });
  it('keeps a pointer dragged past either edge within the usable ratio band', () => {
    expect(splitFromDrag(300, 1000, 0)).toBeLessThanOrEqual(DOCK_SPLIT_MAX);
    expect(splitFromDrag(300, 1000, 5000)).toBeGreaterThanOrEqual(DOCK_SPLIT_MIN);
  });
  it('defaults when the region has no measurable width', () => {
    expect(splitFromDrag(300, 0, 800)).toBe(DOCK_SPLIT_DEFAULT);
  });
});
