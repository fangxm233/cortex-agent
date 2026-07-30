// input:  mobile note pointer deltas
// output: swipe clamp, release and click-suppression regressions
// pos:    Tests mobile note tap and swipe thresholds
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { noteSwipeOffset, resolveNoteGesture, shouldSuppressNoteClick } from './m-notes-gestures';

describe('noteSwipeOffset', () => {
  it('allows only a bounded left reveal', () => {
    expect(noteSwipeOffset(20)).toBe(0);
    expect(noteSwipeOffset(-30)).toBe(-30);
    expect(noteSwipeOffset(-200)).toBe(-78);
  });
});

describe('resolveNoteGesture', () => {
  it('opens delete after a decisive horizontal left swipe', () => {
    expect(resolveNoteGesture({ deltaX: -60, deltaY: 8 })).toBe('delete-open');
  });

  it('closes for vertical scrolling, taps and partial swipes', () => {
    expect(resolveNoteGesture({ deltaX: -20, deltaY: 60 })).toBe('closed');
    expect(resolveNoteGesture({ deltaX: 0, deltaY: 0 })).toBe('closed');
  });
});

describe('shouldSuppressNoteClick', () => {
  it('allows taps and suppresses clicks after drag or scroll movement', () => {
    expect(shouldSuppressNoteClick({ deltaX: 2, deltaY: 3 })).toBe(false);
    expect(shouldSuppressNoteClick({ deltaX: -20, deltaY: 2 })).toBe(true);
    expect(shouldSuppressNoteClick({ deltaX: 2, deltaY: 20 })).toBe(true);
  });
});
