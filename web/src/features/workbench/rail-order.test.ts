// input:  stored manual orders, activity orders and drag moves
// output: reconciliation, move and resolve-order tests
// pos:    Verifies the left rail's two ordering modes
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import {
  isRailSortMode,
  moveInOrder,
  reconcileManualOrder,
  resolveRailOrder,
} from './rail-order';

describe('isRailSortMode', () => {
  it('accepts only the two real modes', () => {
    expect(isRailSortMode('activity')).toBe(true);
    expect(isRailSortMode('manual')).toBe(true);
    expect(isRailSortMode('name')).toBe(false);
    expect(isRailSortMode(null)).toBe(false);
  });
});

describe('reconcileManualOrder', () => {
  it('keeps the stored order for projects that still exist', () => {
    expect(reconcileManualOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('drops ids whose project is gone', () => {
    expect(reconcileManualOrder(['c', 'gone', 'a'], ['a', 'c'])).toEqual(['c', 'a']);
  });

  it('drops duplicate ids from a corrupted payload', () => {
    expect(reconcileManualOrder(['a', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('inserts a new project at its activity position, not at either end', () => {
    // Manual order is c,a; activity says the new project `n` sits between c and a.
    expect(reconcileManualOrder(['c', 'a'], ['c', 'n', 'a'])).toEqual(['c', 'n', 'a']);
  });

  it('inserts a new most-recent project ahead of the manual list', () => {
    expect(reconcileManualOrder(['c', 'a'], ['n', 'c', 'a'])).toEqual(['n', 'c', 'a']);
  });

  it('an empty stored order degrades to the activity order', () => {
    expect(reconcileManualOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('moveInOrder', () => {
  it('moves a project down into the target slot', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a project up into the target slot', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op for unknown ids or a self-drop', () => {
    expect(moveInOrder(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(moveInOrder(['a', 'b'], 'zz', 'b')).toEqual(['a', 'b']);
    expect(moveInOrder(['a', 'b'], 'a', 'zz')).toEqual(['a', 'b']);
  });
});

describe('resolveRailOrder', () => {
  const activity = ['a', 'b', 'c'];
  const manual = ['c', 'b', 'a'];

  it('manual mode always follows the manual order', () => {
    expect(resolveRailOrder('manual', activity, manual, false)).toEqual(['c', 'b', 'a']);
  });

  it('activity mode follows activity when nothing was dragged', () => {
    expect(resolveRailOrder('activity', activity, manual, false)).toEqual(['a', 'b', 'c']);
  });

  it('activity mode honours a drag until activity changes', () => {
    expect(resolveRailOrder('activity', activity, manual, true)).toEqual(['c', 'b', 'a']);
  });

  it('manual mode still reconciles deleted and new projects', () => {
    expect(resolveRailOrder('manual', ['a', 'n'], ['gone', 'a'], false)).toEqual(['a', 'n']);
  });
});
