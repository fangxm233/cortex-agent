// input:  pointer deltas and hold duration for one mobile note row
// output: bounded swipe offset and release outcome
// pos:    Pure gesture policy for mobile project notes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

export const LONG_PRESS_MS = 450;
export const DELETE_REVEAL_PX = 78;
const SWIPE_OPEN_PX = 48;
const HOLD_SLOP_PX = 8;

export type NoteGestureOutcome = 'delete-open' | 'long-press' | 'closed';

export interface NoteGestureInput {
  deltaX: number;
  deltaY: number;
  durationMs: number;
}

export function noteSwipeOffset(deltaX: number): number {
  return Math.max(-DELETE_REVEAL_PX, Math.min(0, deltaX));
}

export function resolveNoteGesture(input: NoteGestureInput): NoteGestureOutcome {
  const horizontal = Math.abs(input.deltaX) > Math.abs(input.deltaY);
  if (horizontal && input.deltaX <= -SWIPE_OPEN_PX) return 'delete-open';
  const stationary = Math.abs(input.deltaX) <= HOLD_SLOP_PX && Math.abs(input.deltaY) <= HOLD_SLOP_PX;
  if (stationary && input.durationMs >= LONG_PRESS_MS) return 'long-press';
  return 'closed';
}
