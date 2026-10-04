import { describe, expect, it } from 'vitest';
import {
  DRAWER_COMMIT_FRACTION,
  DRAWER_FLING_PX_PER_MS,
  DRAWER_LOCK_PX,
  drawerProgress,
  lockDrawerPan,
  panVelocity,
  settleDrawer,
  trimSamples,
} from './m-drawer-gesture';

describe('lockDrawerPan', () => {
  it('waits until the pan has moved far enough to read its direction', () => {
    expect(lockDrawerPan(DRAWER_LOCK_PX - 1, 2, false)).toBe('pending');
    expect(lockDrawerPan(0, 0, true)).toBe('pending');
  });

  it('claims a mostly horizontal pan anywhere on the screen, toward the side the panel can move', () => {
    expect(lockDrawerPan(24, 6, false)).toBe('drawer');
    expect(lockDrawerPan(-24, 6, true)).toBe('drawer');
  });

  it('leaves vertical scrolls, diagonal pans and the wrong direction alone', () => {
    expect(lockDrawerPan(4, 30, false)).toBe('ignore');
    expect(lockDrawerPan(20, 18, false)).toBe('ignore');
    expect(lockDrawerPan(-24, 2, false)).toBe('ignore');
    expect(lockDrawerPan(24, 2, true)).toBe('ignore');
  });
});

describe('drawerProgress', () => {
  it('tracks the finger from the state the pan started in, clamped to the panel', () => {
    expect(drawerProgress(150, 300, false)).toBe(0.5);
    expect(drawerProgress(-75, 300, true)).toBe(0.75);
    expect(drawerProgress(900, 300, false)).toBe(1);
    expect(drawerProgress(-900, 300, true)).toBe(0);
    expect(drawerProgress(-20, 300, false)).toBe(0);
  });

  it('holds the starting state when the panel has no width yet', () => {
    expect(drawerProgress(50, 0, false)).toBe(0);
    expect(drawerProgress(-50, 0, true)).toBe(1);
  });
});

describe('settleDrawer', () => {
  it('lets a fling decide by direction, whatever the distance', () => {
    expect(settleDrawer(0.1, DRAWER_FLING_PX_PER_MS, false)).toBe(true);
    expect(settleDrawer(0.95, -DRAWER_FLING_PX_PER_MS, true)).toBe(false);
    expect(settleDrawer(0.8, -1, false)).toBe(false);
  });

  it('changes state on a slow release only past the commit distance', () => {
    expect(settleDrawer(DRAWER_COMMIT_FRACTION - 0.05, 0, false)).toBe(false);
    expect(settleDrawer(DRAWER_COMMIT_FRACTION, 0, false)).toBe(true);
    expect(settleDrawer(1 - DRAWER_COMMIT_FRACTION + 0.05, 0.1, true)).toBe(true);
    expect(settleDrawer(1 - DRAWER_COMMIT_FRACTION - 0.05, 0, true)).toBe(false);
  });
});

describe('pan velocity', () => {
  it('measures only the last stretch of the pan', () => {
    const samples = [{ x: 0, t: 0 }, { x: 10, t: 150 }, { x: 40, t: 200 }, { x: 90, t: 250 }];
    const recent = trimSamples(samples, 250);
    expect(recent).toEqual(samples.slice(1));
    expect(panVelocity(recent)).toBeCloseTo(0.8);
  });

  it('reads a finger held still before release as no fling', () => {
    const held = trimSamples([{ x: 0, t: 0 }, { x: 120, t: 80 }, { x: 120, t: 400 }], 400);
    expect(panVelocity(held)).toBe(0);
    expect(panVelocity([{ x: 5, t: 10 }])).toBe(0);
  });
});
