import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/**
 * How far a row has to fold to fit its box, as a level from 0 (everything at full size) to
 * `maxLevel`. The caller decides what each level hides or shortens and how to tell that the row
 * still does not fit; this hook only climbs.
 *
 * The algorithm is "start full, fold until it fits": whenever the box's width changes (or
 * `resetKey` does — new text to fit), the level drops back to 0 and every layout pass that still
 * overflows takes one more step. The steps run in layout effects, before paint, so the
 * intermediate states never show. The box's width must not depend on its contents (a row
 * stretched by its parent), or folding would change the very width it measures.
 *
 * Content that grows later is caught by the same overflow check on the next render; content that
 * shrinks keeps its fold until the next resize, which is the cheap side to be wrong on.
 */
export function useFitLevel<T extends HTMLElement>(
  maxLevel: number,
  overflows: (el: T, level: number) => boolean,
  resetKey: string,
): { ref: RefObject<T>; level: number } {
  const ref = useRef<T>(null);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const el = ref.current;
    // No observer under SSR or a node test renderer: the row simply stays at full size.
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // Synchronous, so the re-fit (and the steps it triggers) lands in this frame.
      flushSync(() => setLevel(0));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Declared before the reset below: when both fire in one commit, the reset's 0 is applied last.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && level < maxLevel && overflows(el, level)) setLevel((current) => Math.min(current + 1, maxLevel));
  });

  const firstKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (firstKey.current === resetKey) return;
    firstKey.current = resetKey;
    setLevel(0);
  }, [resetKey]);

  return { ref, level };
}
