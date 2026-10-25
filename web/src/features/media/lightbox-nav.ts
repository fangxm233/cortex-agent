import { useEffect, useRef, type TouchEvent as ReactTouchEvent } from 'react';

// Stepping through the lightbox's group from the keyboard (← / →) and by a horizontal swipe on the
// stage. Neither acts on a video: its own keys seek, and a drag across it may be on its scrubber.
// A swipe is also ignored while the image is zoomed, where one finger pans.

interface Point {
  x: number;
  y: number;
}

const SWIPE_MIN_PX = 60;
/** How much more horizontal than vertical a stroke must be to count as a swipe. */
const SWIPE_AXIS_RATIO = 1.5;
const ARROW_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

/** +1 (next) for a swipe to the left, -1 (previous) to the right, 0 for any other stroke. */
export function swipeStep(down: Point, up: Point): number {
  const dx = up.x - down.x;
  const dy = up.y - down.y;
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < SWIPE_AXIS_RATIO * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export function arrowStep(key: string): number {
  return ARROW_STEPS[key] ?? 0;
}

const isVideo = (target: EventTarget | null): boolean => (target as Element | null)?.tagName === 'VIDEO';
const pointOf = (touch: { clientX: number; clientY: number }): Point => ({ x: touch.clientX, y: touch.clientY });

export interface StageSwipe {
  onTouchStart: (event: ReactTouchEvent) => void;
  onTouchEnd: (event: ReactTouchEvent) => void;
}

function useArrowKeys(step: (delta: number) => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      const delta = arrowStep(event.key);
      if (delta === 0 || isVideo(event.target)) return;
      event.preventDefault();
      step(delta);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, enabled]);
}

function useStageSwipe(step: (delta: number) => void, enabled: boolean): StageSwipe {
  const down = useRef<Point | null>(null);
  return {
    onTouchStart: (event) => {
      const single = event.touches.length === 1 && !isVideo(event.target);
      down.current = enabled && single ? pointOf(event.touches[0]) : null;
    },
    onTouchEnd: (event) => {
      const start = down.current;
      down.current = null;
      if (!start || event.touches.length !== 0) return;
      const delta = swipeStep(start, pointOf(event.changedTouches[0]));
      if (delta !== 0) step(delta);
    },
  };
}

/** Wires ← / → for `enabled` groups and returns the stage's swipe handlers. */
export function useLightboxNav(step: (delta: number) => void, enabled: boolean, zoomed: boolean): StageSwipe {
  useArrowKeys(step, enabled);
  return useStageSwipe(step, enabled && !zoomed);
}
