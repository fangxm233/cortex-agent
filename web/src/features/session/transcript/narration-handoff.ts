import { useLayoutEffect, type RefObject } from 'react';
import { motionAllowed } from '@/design/Collapse';

// While a turn runs, the reply being written sits under the work log as the answer. The moment the
// agent acts again it becomes a working note inside the log, which remounts it there, indented and a
// step quieter. The answer block notes where it stood as it unmounts, in the same commit, and the
// note slides over from that spot instead of fading in again as if it were new.

const SLIDE_MS = 260;
/** Unmount and mount effects of one commit run back to back; anything older is another commit's. */
const SAME_COMMIT_MS = 50;

const left = new Map<string, { top: number; left: number; at: number }>();

function handoffKey(streamKey: string | undefined, text: string): string {
  return `${streamKey ?? ''}\u0000${text.trim().slice(0, 80)}`;
}

/** `narration` false: remember this block's spot when it unmounts. True: slide in from a spot an
 *  answer block with the same text left this commit, if there is one. */
export function useNarrationHandoff(ref: RefObject<HTMLElement>, text: string, streamKey: string | undefined, narration: boolean): void {
  const key = handoffKey(streamKey, text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!narration) {
      return () => {
        const now = performance.now();
        for (const [k, v] of left) if (now - v.at > SAME_COMMIT_MS) left.delete(k);
        const rect = el.getBoundingClientRect();
        left.set(key, { top: rect.top, left: rect.left, at: now });
      };
    }
    const from = left.get(key);
    left.delete(key);
    if (!from || performance.now() - from.at > SAME_COMMIT_MS || !motionAllowed()) return;
    // Drop the entry rise first: measured mid-rise, the note would start from the wrong height.
    el.style.animation = 'none';
    const rect = el.getBoundingClientRect();
    const dx = from.left - rect.left;
    const dy = from.top - rect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'cubic-bezier(.22,1,.36,1)' });
  }, [key, narration]);
}
