// input:  Router outlet, location and mobile tab model
// output: animated outlet with retained tab frame
// pos:    Mobile route-transition wrapper
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigationType, useOutlet } from 'react-router-dom';
import { isTabRootRoute, normalizeMobilePath } from './mobile-tabs';
import { MC } from './ui/kit';

export interface Frame {
  key: string;
  element: ReactNode;
}

type NavType = 'PUSH' | 'POP' | 'REPLACE';
export type SlideDir = 'forward' | 'back';

export function planTransition(
  navType: NavType,
  samePath: boolean,
  reduceMotion: boolean,
  betweenTabRoutes: boolean,
  returningToRetained = false,
): { animate: false } | { animate: true; dir: SlideDir } {
  if (samePath || reduceMotion || betweenTabRoutes) return { animate: false };
  if (returningToRetained) return { animate: true, dir: 'back' };
  if (navType === 'REPLACE') return { animate: false };
  return { animate: true, dir: navType === 'POP' ? 'back' : 'forward' };
}

function sameRoute(left: string, right: string): boolean {
  return normalizeMobilePath(left) === normalizeMobilePath(right);
}

export function planFrameChange(
  current: Frame,
  retainedTab: Frame | null,
  destination: Frame,
): { current: Frame; retainedTab: Frame | null; returningToRetained: boolean } {
  if (retainedTab && sameRoute(retainedTab.key, destination.key)) {
    return { current: retainedTab, retainedTab: null, returningToRetained: true };
  }
  const startsDrillIn = isTabRootRoute(current.key) && !isTabRootRoute(destination.key);
  if (startsDrillIn) {
    return { current: destination, retainedTab: current, returningToRetained: false };
  }
  return {
    current: destination,
    retainedTab: isTabRootRoute(destination.key) ? null : retainedTab,
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

const layerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: MC.canvas,
};

const retainedStyle: CSSProperties = {
  ...layerStyle,
  visibility: 'hidden',
  pointerEvents: 'none',
};

function useAnimatedFrames(pathname: string, navType: NavType, outlet: ReactNode) {
  const [current, setCurrent] = useState<Frame>({ key: pathname, element: outlet });
  const [retainedTab, setRetainedTab] = useState<Frame | null>(null);
  const [previous, setPrevious] = useState<Frame | null>(null);
  const [dir, setDir] = useState<SlideDir>('forward');

  useLayoutEffect(() => {
    if (sameRoute(pathname, current.key)) return;
    const destination = { key: pathname, element: outlet };
    const change = planFrameChange(current, retainedTab, destination);
    const betweenTabs = isTabRootRoute(current.key) && isTabRootRoute(pathname);
    const plan = planTransition(
      navType,
      false,
      prefersReducedMotion(),
      betweenTabs,
      change.returningToRetained,
    );
    setRetainedTab(change.retainedTab);
    setPrevious(plan.animate ? current : null);
    if (plan.animate) setDir(plan.dir);
    setCurrent(change.current);
    // Each destination path is processed once with the current frame snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return { current, retainedTab, previous, dir, onSettled: () => setPrevious(null) };
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

function AnimatedOutletLayers({ current, retainedTab, previous, dir, onSettled }: {
  current: Frame;
  retainedTab: Frame | null;
  previous: Frame | null;
  dir: SlideDir;
  onSettled: () => void;
}) {
  const classes = slideAnimClasses(dir);
  const showRetained = retainedTab
    && retainedTab.key !== previous?.key
    && retainedTab.key !== current.key;
  return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {showRetained && <RouteLayer key={retainedTab.key} frame={retainedTab} role="retained" hidden />}
      {previous && (
        <RouteLayer key={previous.key} frame={previous} role="previous" className={classes.outgoing} />
      )}
      <RouteLayer
        key={current.key}
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
  const frames = useAnimatedFrames(location.pathname, navType, outlet);
  return <AnimatedOutletLayers {...frames} />;
}
