// input:  mobile note gesture deltas and hold durations
// output: swipe clamp and gesture outcome regressions
// pos:    Tests scheme 26c long-press and swipe thresholds
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, noteSwipeOffset, resolveNoteGesture } from './m-notes-gestures';

describe('noteSwipeOffset', () => {
  it('allows only a bounded left reveal', () => {
    expect(noteSwipeOffset(20)).toBe(0);
    expect(noteSwipeOffset(-30)).toBe(-30);
    expect(noteSwipeOffset(-200)).toBe(-78);
  });
});

describe('resolveNoteGesture', () => {
  it('opens delete after a decisive horizontal left swipe', () => {
    expect(resolveNoteGesture({ deltaX: -60, deltaY: 8, durationMs: 180 })).toBe('delete-open');
  });

  it('opens actions after a stationary 450ms hold', () => {
    expect(resolveNoteGesture({ deltaX: 2, deltaY: 3, durationMs: LONG_PRESS_MS })).toBe('long-press');
  });

  it('closes for vertical scrolling, short taps and partial swipes', () => {
    expect(resolveNoteGesture({ deltaX: -20, deltaY: 60, durationMs: 200 })).toBe('closed');
    expect(resolveNoteGesture({ deltaX: 0, deltaY: 0, durationMs: 120 })).toBe('closed');
  });
});
