// input:  pointer deltas for one mobile note row
// output: bounded swipe offset, release and click-suppression policy
// pos:    Pure gesture policy for mobile project notes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

export const DELETE_REVEAL_PX = 78;
const SWIPE_OPEN_PX = 48;
const GESTURE_SLOP_PX = 8;

export type NoteGestureOutcome = 'delete-open' | 'closed';

export interface NoteGestureInput {
  deltaX: number;
  deltaY: number;
}

export function noteSwipeOffset(deltaX: number): number {
  return Math.max(-DELETE_REVEAL_PX, Math.min(0, deltaX));
}

export function resolveNoteGesture(input: NoteGestureInput): NoteGestureOutcome {
  const horizontal = Math.abs(input.deltaX) > Math.abs(input.deltaY);
  return horizontal && input.deltaX <= -SWIPE_OPEN_PX ? 'delete-open' : 'closed';
}

export function shouldSuppressNoteClick(input: NoteGestureInput): boolean {
  return Math.abs(input.deltaX) > GESTURE_SLOP_PX || Math.abs(input.deltaY) > GESTURE_SLOP_PX;
}
