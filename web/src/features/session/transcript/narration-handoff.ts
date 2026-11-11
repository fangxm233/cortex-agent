import { useLayoutEffect, type RefObject } from 'react';
import { motionAllowed } from '@/design/Collapse';

// A text the agent writes changes place between the open work log and the answer below it: a reply
// that turns out to be a working note joins the log when the agent acts again, and a note in the log
// steps out as the answer when it grows long or the turn ends on it. Either way the block remounts
// in its new place, indented or not and a step quieter or louder. The block notes where it stood as
// it unmounts, and its other self, mounted in the same commit, slides over from that spot instead of
// fading in again as if it were new.

const SLIDE_MS = 260;
/** Unmount and mount effects of one commit run back to back; anything older is another commit's. */
const SAME_COMMIT_MS = 50;

const left = new Map<string, { top: number; left: number; at: number; narration: boolean }>();

function handoffKey(streamKey: string | undefined, text: string): string {
  return `${streamKey ?? ''}\u0000${text.trim().slice(0, 80)}`;
}

/** Remember this block's spot when it unmounts, and slide in from a spot a block with the same text
 *  left this commit from the other side of the log edge, if there is one. */
export function useNarrationHandoff(ref: RefObject<HTMLElement>, text: string, streamKey: string | undefined, narration: boolean): void {
  const key = handoffKey(streamKey, text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = left.get(key);
    if (from && from.narration !== narration) {
      left.delete(key);
      if (performance.now() - from.at <= SAME_COMMIT_MS && motionAllowed()) slideFrom(el, from);
    }
    return () => {
      const now = performance.now();
      for (const [k, v] of left) if (now - v.at > SAME_COMMIT_MS) left.delete(k);
      const rect = el.getBoundingClientRect();
      left.set(key, { top: rect.top, left: rect.left, at: now, narration });
    };
  }, [key, narration]);
}

function slideFrom(el: HTMLElement, from: { top: number; left: number }): void {
  // Drop the entry rise first: measured mid-rise, the block would start from the wrong height.
  el.style.animation = 'none';
  const rect = el.getBoundingClientRect();
  const dx = from.left - rect.left;
  const dy = from.top - rect.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'cubic-bezier(.22,1,.36,1)' });
}
