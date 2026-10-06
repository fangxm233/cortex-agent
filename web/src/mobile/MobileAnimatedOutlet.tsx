import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigationType, useOutlet } from 'react-router-dom';
import { mobileHomeView, mobileScreenKey } from './mobile-route-manifest';
import { MC } from './ui/kit';

export interface Frame {
  /** Screen key of the path the frame shows. */
  key: string;
  element: ReactNode;
  /** React identity of the layer; defaults to `key`. A re-pointed screen keeps its own. */
  id?: string;
}

/** Navigation state for a `replace` that re-points the current screen at a new path instead of
 *  swapping in a new one — a new-session draft becoming the session its first message created,
 *  with the screen (and what it holds for that message) staying put. */
export const SAME_SCREEN_STATE = { sameScreen: true } as const;

function keepsScreen(navType: NavType, state: unknown): boolean {
  return navType === 'REPLACE' && (state as { sameScreen?: unknown } | null)?.sameScreen === true;
}

type NavType = 'PUSH' | 'POP' | 'REPLACE';
export type SlideDir = 'forward' | 'back';

function planTransition(
  navType: NavType,
  reduceMotion: boolean,
  returningToRetained: boolean,
): { animate: false } | { animate: true; dir: SlideDir } {
  if (reduceMotion) return { animate: false };
  if (returningToRetained) return { animate: true, dir: 'back' };
  if (navType === 'REPLACE') return { animate: false };
  return { animate: true, dir: navType === 'POP' ? 'back' : 'forward' };
}

function sameScreen(left: string, right: string): boolean {
  return mobileScreenKey(left) === mobileScreenKey(right);
}

function isHome(key: string): boolean {
  return mobileHomeView(key) !== null;
}

// The home screen stays mounted (hidden) while the user drills in from it, so coming back restores
// its scroll position and Projects panel instead of rebuilding it.
export function planFrameChange(
  current: Frame,
  retainedHome: Frame | null,
  destination: Frame,
): { current: Frame; retainedHome: Frame | null; returningToRetained: boolean } {
  if (retainedHome && sameScreen(retainedHome.key, destination.key)) {
    return { current: retainedHome, retainedHome: null, returningToRetained: true };
  }
  const startsDrillIn = isHome(current.key) && !isHome(destination.key);
  if (startsDrillIn) {
    return { current: destination, retainedHome: current, returningToRetained: false };
  }
  return {
    current: destination,
    retainedHome: isHome(destination.key) ? null : retainedHome,
    returningToRetained: false,
  };
}

function slideAnimClasses(dir: SlideDir): { incoming: string; outgoing: string } {
  return dir === 'forward'
    ? { incoming: 'animate-slide-in-right', outgoing: 'animate-slide-out-left' }
    : { incoming: 'animate-slide-in-left', outgoing: 'animate-slide-out-right' };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The layer needs its own stacking context: layers are absolute with z-index auto, so without one a
// positioned child (the sticky subagent header) escapes to the shell's context and paints OVER the
// incoming route -- visible as a flash in the gap between the 160ms outgoing slide and the 200ms
// incoming one, where the outgoing layer has dropped its transform (and with it the stacking
// context) but is not unmounted yet.
//
// It must be `z-index: 0` and NOT `isolation: isolate`: isolation also makes the layer a BACKDROP
// ROOT, which silently turns every `backdrop-filter` inside the route into a no-op — the floating
// chat header and composer then read as flat translucent panes with sharp text showing through.
// A z-index stacking context solves the escape problem without capping the backdrop.
//
// Each layer carries the mesh ground itself rather than letting the shell's show through: during a
// slide the outgoing and incoming layers overlap, so a transparent layer would read as two screens
// printed on top of each other. `--app-backdrop` bottoms out in a solid colour, so it occludes.
const layerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: MC.backdrop,
  zIndex: 0,
};

const retainedStyle: CSSProperties = {
  ...layerStyle,
  visibility: 'hidden',
  pointerEvents: 'none',
};

function useAnimatedFrames(pathname: string, navType: NavType, state: unknown, outlet: ReactNode) {
  // Layer ids stay unique even when a re-pointed screen's old path is opened again beside it.
  const nextId = useRef(0);
  const frameAt = (path: string): Frame => ({ key: mobileScreenKey(path), element: outlet, id: `${nextId.current++}` });
  const [current, setCurrent] = useState<Frame>(() => frameAt(pathname));
  const [retainedHome, setRetainedHome] = useState<Frame | null>(null);
  const [previous, setPrevious] = useState<Frame | null>(null);
  const [dir, setDir] = useState<SlideDir>('forward');

  useLayoutEffect(() => {
    // Opening or closing the Projects panel keeps the same home screen; only a new screen swaps.
    if (sameScreen(pathname, current.key)) return;
    if (keepsScreen(navType, state)) {
      setCurrent({ ...current, key: mobileScreenKey(pathname), element: outlet });
      return;
    }
    const destination = frameAt(pathname);
    const change = planFrameChange(current, retainedHome, destination);
    const plan = planTransition(navType, prefersReducedMotion(), change.returningToRetained);
    setRetainedHome(change.retainedHome);
    setPrevious(plan.animate ? current : null);
    if (plan.animate) setDir(plan.dir);
    setCurrent(change.current);
    // Each destination path is processed once with the current frame snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return { current, retainedHome, previous, dir, onSettled: () => setPrevious(null) };
}

interface RouteLayerProps {
  frame: Frame;
  role: 'retained' | 'previous' | 'current';
  className?: string;
  hidden?: boolean;
  onAnimationEnd?: () => void;
}

function RouteLayer({ frame, role, className, hidden, onAnimationEnd }: RouteLayerProps) {
  return (
    <div
      data-route-layer={role}
      data-route-key={frame.key}
      className={className}
      style={hidden ? retainedStyle : layerStyle}
      aria-hidden={role === 'current' ? undefined : true}
      onAnimationEnd={onAnimationEnd}
    >
      {frame.element}
    </div>
  );
}

const layerKey = (frame: Frame): string => frame.id ?? frame.key;

export function AnimatedOutletLayers({ current, retainedHome, previous, dir, onSettled }: {
  current: Frame;
  retainedHome: Frame | null;
  previous: Frame | null;
  dir: SlideDir;
  onSettled: () => void;
}) {
  const classes = slideAnimClasses(dir);
  const showRetained = retainedHome
    && retainedHome.key !== previous?.key
    && retainedHome.key !== current.key;
  return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {showRetained && <RouteLayer key={layerKey(retainedHome)} frame={retainedHome} role="retained" hidden />}
      {previous && (
        <RouteLayer key={layerKey(previous)} frame={previous} role="previous" className={classes.outgoing} />
      )}
      <RouteLayer
        key={layerKey(current)}
        frame={current}
        role="current"
        className={previous ? classes.incoming : undefined}
        onAnimationEnd={previous ? onSettled : undefined}
      />
    </div>
  );
}

export function AnimatedOutlet() {
  const location = useLocation();
  const navType = useNavigationType();
  const outlet = useOutlet();
  const frames = useAnimatedFrames(location.pathname, navType, location.state, outlet);
  return <AnimatedOutletLayers {...frames} />;
}
