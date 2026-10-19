import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Content that opens under a line — a turn's work, a tool run, a thought — grows and fades in, and
// shrinks away before it unmounts. Settled open it clips nothing, so sticky headers and the hover
// tint that rows bleed past their column keep working. Without a DOM (tests) or with reduced motion
// it opens and closes in one step.

const OPEN_MS = 200;
const EASE = 'cubic-bezier(.2,.8,.2,1)';

export function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const mode = document.documentElement.getAttribute('data-motion');
  if (mode === 'reduced') return false;
  if (mode === 'full') return true;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** False while a Collapse is opening: the rows it mounts arrive with it, not one by one. */
const EntryMotionContext = createContext(true);

/** A row's own entry animation, decided once when it mounts: none for rows that a Collapse is
 *  opening (the Collapse animates them as one), the given one for rows that arrive on their own. */
export function useEntryAnimation(animation: string): string | undefined {
  const allowed = useContext(EntryMotionContext);
  const [value] = useState(allowed ? animation : undefined);
  return value;
}

export function Collapse({ open, children }: { open: boolean; children: ReactNode }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ mounted: open, settled: true });
  if (open && !state.mounted) setState({ mounted: true, settled: false });
  const shown = useRef(open);

  useLayoutEffect(() => {
    if (shown.current === open) return;
    shown.current = open;
    const el = ref.current;
    const done = (): void => setState(open ? { mounted: true, settled: true } : { mounted: false, settled: true });
    if (!el || !motionAllowed()) {
      done();
      return;
    }
    const height = el.getBoundingClientRect().height;
    el.style.overflow = 'hidden';
    const frames = [{ height: '0px', opacity: 0 }, { height: `${height}px`, opacity: 1 }];
    // Closing holds its last frame, still clipped, until the unmount lands: unclipped, the body
    // would spill out of its zero height and stretch the scroller for a frame, and a pinned view
    // would jump to the stretched bottom and back.
    const animation = el.animate(open ? frames : frames.reverse(), { duration: OPEN_MS, easing: EASE, fill: open ? 'none' : 'forwards' });
    animation.onfinish = () => {
      if (open) el.style.overflow = '';
      done();
    };
    return () => {
      animation.onfinish = null;
      animation.cancel();
      el.style.overflow = '';
    };
  }, [open]);

  if (!state.mounted) return null;
  return (
    <div ref={ref} data-collapse="" style={{ display: 'flow-root', minWidth: 0 }}>
      <EntryMotionContext.Provider value={state.settled}>{children}</EntryMotionContext.Provider>
    </div>
  );
}
