// The home's Projects panel follows a horizontal pan that can start anywhere on the screen: Android
// gesture navigation owns the left edge for Back, so an edge-only swipe would be unreachable there.
// A pan is claimed only once it has moved far enough to read its direction, and only when it is
// mostly horizontal and heads the way the panel can move; anything else stays a scroll or a tap.

/** Movement before a pan's direction is read; under it a touch is still a possible tap. */
export const DRAWER_LOCK_PX = 10;
/** Horizontal must beat vertical by this factor (≈40° either side of the axis). */
const HORIZONTAL_BIAS = 1.2;
/** Release speed (px/ms) that decides the outcome on its own, whatever the distance. */
export const DRAWER_FLING_PX_PER_MS = 0.4;
/** Share of the panel width a slow pan must cover to change the panel's state. */
export const DRAWER_COMMIT_FRACTION = 0.35;
/** Velocity is measured over the last stretch of the pan, not its whole length. */
const VELOCITY_WINDOW_MS = 100;

export type DrawerLock = 'pending' | 'drawer' | 'ignore';

export function lockDrawerPan(dx: number, dy: number, open: boolean): DrawerLock {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAWER_LOCK_PX) return 'pending';
  if (Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_BIAS) return 'ignore';
  return (open ? dx < 0 : dx > 0) ? 'drawer' : 'ignore';
}

/** How far open (0–1) the panel sits under the finger, from where the pan started. */
export function drawerProgress(dx: number, width: number, open: boolean): number {
  if (width <= 0) return open ? 1 : 0;
  const progress = (open ? 1 : 0) + dx / width;
  return Math.min(1, Math.max(0, progress));
}

/** Whether the panel ends open: a fling decides by direction, a slow release by distance covered. */
export function settleDrawer(progress: number, velocity: number, startedOpen: boolean): boolean {
  if (velocity >= DRAWER_FLING_PX_PER_MS) return true;
  if (velocity <= -DRAWER_FLING_PX_PER_MS) return false;
  return startedOpen ? progress > 1 - DRAWER_COMMIT_FRACTION : progress >= DRAWER_COMMIT_FRACTION;
}

export interface PanSample {
  x: number;
  t: number;
}

/** Keep only the samples inside the velocity window, newest last. */
export function trimSamples(samples: PanSample[], now: number): PanSample[] {
  const kept = samples.filter((sample) => now - sample.t <= VELOCITY_WINDOW_MS);
  return kept.length > 0 ? kept : samples.slice(-1);
}

/** Horizontal speed in px/ms across the samples (positive = rightward). */
export function panVelocity(samples: PanSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}
