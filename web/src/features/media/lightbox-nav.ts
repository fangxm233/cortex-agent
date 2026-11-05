import { useCallback, useEffect, useRef, type RefObject, type TouchEvent as ReactTouchEvent } from 'react';
import { flushSync } from 'react-dom';

// Stepping through the lightbox's group from the keyboard (← / →) and by swiping the stage. The
// stage lays the shown item and its neighbours on a horizontal track that follows the finger; on
// release the track slides on to the neighbour (and only then steps to it) or springs back.
// Neither acts on a video: its own keys seek, and a drag across it may be on its scrubber. A swipe
// is also ignored while the image is zoomed, where one finger pans.

type Axis = 'x' | 'y';

interface Sample {
  x: number;
  t: number;
}

interface Drag {
  x0: number;
  y0: number;
  /** Decided once the stroke leaves the slop; only an 'x' stroke moves the track. */
  axis: Axis | null;
  samples: Sample[];
}

const AXIS_SLOP_PX = 8;
/** A slow drag moves on once it covers this share of the screen width. */
const COMMIT_FRACTION = 0.2;
const FLICK_PX_PER_MS = 0.4;
const FLICK_MIN_PX = 24;
const VELOCITY_WINDOW_MS = 100;
const EDGE_RESISTANCE = 0.3;
const SETTLE_MS = 240;
const SETTLE_EASE = 'cubic-bezier(.2,.8,.2,1)';
const ARROW_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

/** Neighbouring slides sit one screen width apart; the stage is narrower, so at rest they are off-screen. */
export const SLIDE_PITCH = '100vw';

/** The axis a stroke commits to once it leaves the slop; null while still inside it. */
export function strokeAxis(dx: number, dy: number): Axis | null {
  if (Math.hypot(dx, dy) < AXIS_SLOP_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/** The track follows the finger 1:1, but resists being pulled past either end of the group. */
export function trackOffset(dx: number, index: number, count: number): number {
  const pastEnd = dx > 0 ? index === 0 : index === count - 1;
  return pastEnd ? dx * EDGE_RESISTANCE : dx;
}

/** +1 (next) / -1 (previous) when a released drag moves on, 0 when it springs back: a drag past a
 *  fifth of the width or a quick flick, toward a side that has an item. A release flicked against
 *  the drag springs back. `velocity` is the finger's px/ms, negative leftward. */
export function releaseStep(dx: number, velocity: number, width: number, index: number, count: number): number {
  const flick = Math.abs(velocity) >= FLICK_PX_PER_MS ? Math.sign(velocity) : 0;
  if (flick !== 0 && flick !== Math.sign(dx)) return 0;
  const minPx = flick !== 0 ? FLICK_MIN_PX : width * COMMIT_FRACTION;
  const delta = dx < 0 ? 1 : -1;
  const inGroup = index + delta >= 0 && index + delta < count;
  return Math.abs(dx) >= minPx && inGroup ? delta : 0;
}

export function arrowStep(key: string): number {
  return ARROW_STEPS[key] ?? 0;
}

const isVideo = (target: EventTarget | null): boolean => (target as Element | null)?.tagName === 'VIDEO';

/** Finger speed (px/ms) across `samples` (the stroke's last stretch); 0 if it ended held still. */
function velocityOf(samples: readonly Sample[]): number {
  const first = samples[0];
  const last = samples[samples.length - 1];
  return last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
}

function placeTrack(track: HTMLDivElement | null, transform: string, animate: boolean): void {
  if (!track) return;
  track.style.transition = animate ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}` : '';
  track.style.transform = transform;
}

export interface StageSwipe {
  /** The row of slides the finger moves; the stage's touch target holds it. */
  trackRef: RefObject<HTMLDivElement>;
  handlers: {
    onTouchStart: (event: ReactTouchEvent) => void;
    onTouchMove: (event: ReactTouchEvent) => void;
    onTouchEnd: (event: ReactTouchEvent) => void;
    onTouchCancel: () => void;
  };
}

interface TrackSettle {
  /** Animates the track onto the neighbour `delta` away (stepping to it at the end), or back for 0. */
  start: (delta: number) => void;
  /** Ends a running slide at once — a new touch must not wait out the animation. */
  finish: () => void;
}

function useTrackSettle(trackRef: RefObject<HTMLDivElement>, step: (delta: number) => void): TrackSettle {
  const pending = useRef<{ delta: number; timer: number } | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  const finish = useCallback(() => {
    const settle = pending.current;
    if (!settle) return;
    pending.current = null;
    window.clearTimeout(settle.timer);
    // Step and recentre in one task, so no frame shows the new slide offset by the old shift.
    if (settle.delta !== 0) flushSync(() => stepRef.current(settle.delta));
    placeTrack(trackRef.current, '', false);
  }, [trackRef]);
  const start = useCallback((delta: number) => {
    pending.current = { delta, timer: window.setTimeout(finish, SETTLE_MS + 20) };
    const target = delta === 0 ? 'translate3d(0px, 0, 0)' : `translate3d(calc(${-delta} * ${SLIDE_PITCH}), 0, 0)`;
    placeTrack(trackRef.current, target, true);
  }, [finish, trackRef]);
  useEffect(() => () => window.clearTimeout(pending.current?.timer), []);
  return { start, finish };
}

const recent = (samples: readonly Sample[], now: number): Sample[] => samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);

/** Moves the track under a one-finger stroke once the stroke has locked to the horizontal. */
function follow(d: Drag, event: ReactTouchEvent, track: HTMLDivElement | null, index: number, count: number): void {
  const { clientX, clientY } = event.touches[0];
  d.axis ??= strokeAxis(clientX - d.x0, clientY - d.y0);
  if (d.axis !== 'x') return;
  d.samples = [...recent(d.samples, event.timeStamp), { x: clientX, t: event.timeStamp }];
  placeTrack(track, `translate3d(${trackOffset(clientX - d.x0, index, count)}px, 0, 0)`, false);
}

/** Where a horizontal stroke lands on release: +1 / -1 to move on, 0 to spring back. */
function released(d: Drag, event: ReactTouchEvent, index: number, count: number): number {
  const x = event.changedTouches[0].clientX;
  const samples = [...recent(d.samples, event.timeStamp), { x, t: event.timeStamp }];
  return releaseStep(x - d.x0, velocityOf(samples), window.innerWidth, index, count);
}

function useStageSwipe(step: (delta: number) => void, index: number, count: number, enabled: boolean): StageSwipe {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const settle = useTrackSettle(trackRef, step);
  const onTouchStart = (event: ReactTouchEvent): void => {
    settle.finish();
    if (drag.current?.axis === 'x') settle.start(0);
    const single = event.touches.length === 1 && !isVideo(event.target);
    const touch = event.touches[0];
    drag.current = enabled && single ? { x0: touch.clientX, y0: touch.clientY, axis: null, samples: [] } : null;
  };
  const onTouchMove = (event: ReactTouchEvent): void => {
    if (drag.current && event.touches.length === 1) follow(drag.current, event, trackRef.current, index, count);
  };
  const onTouchEnd = (event: ReactTouchEvent): void => {
    const d = drag.current;
    if (!d || event.touches.length !== 0) return;
    drag.current = null;
    if (d.axis === 'x') settle.start(released(d, event, index, count));
  };
  const onTouchCancel = (): void => {
    if (drag.current?.axis === 'x') settle.start(0);
    drag.current = null;
  };
  return { trackRef, handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } };
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

/** Wires ← / → for a group and returns the stage's swipe track and touch handlers. */
export function useLightboxNav(step: (delta: number) => void, index: number, count: number, zoomed: boolean): StageSwipe {
  useArrowKeys(step, count > 1);
  return useStageSwipe(step, index, count, count > 1 && !zoomed);
}
