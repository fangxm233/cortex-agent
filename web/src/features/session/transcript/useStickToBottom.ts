import { useEffect, useLayoutEffect, useRef, type DependencyList, type MutableRefObject, type RefObject } from 'react';

/** Within this many px of the bottom the view counts as pinned. */
const PIN_SLACK = 40;

export interface StickToBottomOptions {
  /** Identity of the stream (the session). A new one always opens at its latest message — the
   *  scroller may outlive a switch, and must not keep the previous one's offset or released pin. */
  streamKey?: string;
  /** What the content is drawn from. After each change a pinned view follows to the bottom; the
   *  list must keep the same length across renders. */
  changes: DependencyList;
  /** After a tap inside the stream, hold auto-scroll this long, so a row the tap expanded is not
   *  scrolled out of view by the next streamed frame. */
  freezeMs?: number;
}

export interface StickToBottom {
  /** Part of the scroller's onScroll: scrolling up releases the pin, back to the bottom re-pins. */
  onScroll: () => void;
  /** A tap inside the stream (no-op without `freezeMs`). */
  freeze: () => void;
  /** Stop following, e.g. before jumping to an earlier message. */
  release: () => void;
  /** Following the latest message right now. */
  pinned: () => boolean;
}

/**
 * Keeps a transcript pinned to its latest message while content streams in, shared by the desktop
 * MessageStream and the mobile chat. Rows changing and the content box GROWING both follow: the
 * streamed reply is revealed character by character, so the block gets taller many times per row
 * change, and without the observer the line being written would slide under the bottom edge and
 * snap back on the next delta. The observer writes scrollTop directly — no state, no render.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement>,
  contentRef: RefObject<HTMLElement>,
  options: StickToBottomOptions,
): StickToBottom {
  const pinned = useRef(true);
  const frozenUntil = useRef(0);
  const follow = (): void => {
    const el = scrollRef.current;
    if (el && pinned.current && Date.now() >= frozenUntil.current) el.scrollTop = el.scrollHeight;
  };

  // Layout phase, so the previous stream's offset is never painted.
  useLayoutEffect(() => {
    pinned.current = true;
    frozenUntil.current = 0;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [options.streamKey, scrollRef]);

  // The caller names what its content is drawn from.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(follow, options.changes);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
    // `follow` reads refs only, so the first one stays current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentRef]);

  return controls(scrollRef, pinned, frozenUntil, options.freezeMs);
}

function controls(
  scrollRef: RefObject<HTMLElement>,
  pinned: MutableRefObject<boolean>,
  frozenUntil: MutableRefObject<number>,
  freezeMs: number | undefined,
): StickToBottom {
  return {
    onScroll: () => {
      const el = scrollRef.current;
      if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
    },
    freeze: () => {
      if (freezeMs) frozenUntil.current = Date.now() + freezeMs;
    },
    release: () => { pinned.current = false; },
    pinned: () => pinned.current,
  };
}
