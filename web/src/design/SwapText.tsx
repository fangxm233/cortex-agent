import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { motionAllowed } from './Collapse';

// One line of text that rolls to its next value instead of jumping: the old words slide up and fade
// while the new ones rise into their place, clipped to the line. For a status line whose content
// changes while the reader watches it — a tool run taking in its next call or thought. Without a DOM
// or with reduced motion it swaps in one step.

const SWAP_MS = 240;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const SHIFT = '70%';

const boxStyle: CSSProperties = { position: 'relative', display: 'block', minWidth: 0, overflow: 'hidden' };
const lineStyle: CSSProperties = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const leavingStyle: CSSProperties = { ...lineStyle, position: 'absolute', inset: 0, pointerEvents: 'none' };

function roll(enter: HTMLElement | null, exit: HTMLElement | null, done: () => void): () => void {
  const timing = { duration: SWAP_MS, easing: EASE };
  const rise = enter?.animate([{ transform: `translateY(${SHIFT})`, opacity: 0 }, { transform: 'none', opacity: 1 }], timing);
  // The leaving line holds its last frame until it unmounts, or it flashes back for a frame.
  const fall = exit?.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(-${SHIFT})`, opacity: 0 }], { ...timing, fill: 'forwards' });
  if (!fall) {
    done();
    return () => rise?.cancel();
  }
  fall.onfinish = done;
  return () => {
    fall.onfinish = null;
    fall.cancel();
    rise?.cancel();
  };
}

export function SwapText({ text, style }: { text: string; style?: CSSProperties }): JSX.Element {
  const [shown, setShown] = useState(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  if (shown !== text) {
    setShown(text);
    setLeaving(motionAllowed() ? shown : null);
  }
  const enterRef = useRef<HTMLSpanElement>(null);
  const exitRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (leaving === null) return;
    return roll(enterRef.current, exitRef.current, () => setLeaving(null));
  }, [leaving, shown]);

  return (
    <span data-swap-text="" style={{ ...boxStyle, ...style }}>
      <span ref={enterRef} style={lineStyle}>{shown}</span>
      {leaving !== null && <span ref={exitRef} aria-hidden="true" style={leavingStyle}>{leaving}</span>}
    </span>
  );
}
