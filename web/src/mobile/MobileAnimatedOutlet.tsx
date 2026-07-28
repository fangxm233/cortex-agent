// input:  react-router outlet/location and mobile tab routing
// output: AnimatedOutlet plus pure transition planning
// pos:    Mobile route-transition wrapper
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
// Route-transition wrapper for the mobile shell. Replaces the bare <Outlet/> so screen swaps
// animate as a horizontal slide (iOS-style push/pop) instead of a hard cut:
//   • forward nav (PUSH)  → incoming screen slides in from the right, outgoing shifts out to the left
//   • back nav    (POP)   → outgoing screen slides out to the right, previous slides back in from the left
//   • REPLACE (index/catch-all redirects, e.g. `/`→`/m/sessions`) → instant swap, no slide on load
//   • between the 4 bottom-Tab screens (会话/线程/任务/项目) → instant swap, no slide (per design: the
//     Tab bar is a flat switch, not a drill-in stack; only drill-in sub-screens slide)
//
// It works with the data router by FREEZING the outgoing route element: `useOutlet()` always returns
// the element for the *current* location, so on a navigation we snapshot the previous element (React
// elements are immutable, and each carries its own RouteContext — stale params/hooks keep resolving to
// the old screen) and render both layers, absolutely stacked, until the incoming animation ends.
// Honors `prefers-reduced-motion` by skipping the slide entirely. Uses the existing Tailwind
// `animate-slide-*` utilities (tailwind.config.ts) — no new animation deps.
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigationType, useOutlet } from 'react-router-dom';
import { isTabRoute } from './mobile-tabs';
import { MC } from './ui/kit';

type Frame = { key: string; element: ReactNode };
type NavType = 'PUSH' | 'POP' | 'REPLACE';
export type SlideDir = 'forward' | 'back';

// Pure transition planner (extracted so it is testable without a DOM — the vitest env is `node`).
// Given the router's navigation type and the endpoints, decide whether to animate a directional slide
// and in which direction. Instant swap (no slide) when: same path, reduced-motion, REPLACE (index/
// catch-all redirects), or a switch BETWEEN two bottom-Tab screens (the Tab bar is a flat switch, not a
// drill-in stack). Otherwise PUSH slides forward, POP slides back.
export function planTransition(
  navType: NavType,
  samePath: boolean,
  reduceMotion: boolean,
  betweenTabRoutes: boolean,
): { animate: false } | { animate: true; dir: SlideDir } {
  if (samePath || reduceMotion || navType === 'REPLACE' || betweenTabRoutes) return { animate: false };
  return { animate: true, dir: navType === 'POP' ? 'back' : 'forward' };
}

// Tailwind `animate-slide-*` utility pair for a given direction (incoming layer / outgoing layer).
function slideAnimClasses(dir: SlideDir): { incoming: string; outgoing: string } {
  return dir === 'forward'
    ? { incoming: 'animate-slide-in-right', outgoing: 'animate-slide-out-left' }
    : { incoming: 'animate-slide-in-left', outgoing: 'animate-slide-out-right' };
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const layerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: MC.canvas,
};

function useAnimatedFrames(pathname: string, navType: NavType, outlet: ReactNode) {
  const [current, setCurrent] = useState<Frame>({ key: pathname, element: outlet });
  const [previous, setPrevious] = useState<Frame | null>(null);
  const [dir, setDir] = useState<SlideDir>('forward');

  useLayoutEffect(() => {
    const samePath = pathname === current.key;
    const betweenTabRoutes = isTabRoute(current.key) && isTabRoute(pathname);
    const plan = planTransition(navType, samePath, prefersReducedMotion(), betweenTabRoutes);
    if (samePath) return;
    if (!plan.animate) {
      setPrevious(null);
      setCurrent({ key: pathname, element: outlet });
      return;
    }
    setPrevious(current);
    setDir(plan.dir);
    setCurrent({ key: pathname, element: outlet });
    // Run once per destination path change; `outlet`/`current` are read fresh from the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return { current, previous, dir, onSettled: () => setPrevious(null) };
}

function AnimatedOutletLayers({ current, previous, dir, onSettled }: {
  current: Frame;
  previous: Frame | null;
  dir: SlideDir;
  onSettled: () => void;
}) {
  const classes = slideAnimClasses(dir);
  return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {previous && (
        <div
          key={previous.key}
          data-route-layer="previous"
          data-route-key={previous.key}
          className={classes.outgoing}
          style={layerStyle}
          aria-hidden
        >
          {previous.element}
        </div>
      )}
      <div
        key={current.key}
        data-route-layer="current"
        data-route-key={current.key}
        className={previous ? classes.incoming : undefined}
        style={layerStyle}
        onAnimationEnd={previous ? onSettled : undefined}
      >
        {current.element}
      </div>
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
