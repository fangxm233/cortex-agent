import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

// A long session is opened at its latest message, so mounting the whole transcript up front pays
// for hundreds of rows nobody is looking at — and every live update re-renders all of them. The
// window mounts only the tail and grows toward the top as the reader scrolls there. Rows keep their
// GLOBAL index (keys, nav anchors, edit targets), so growing the window never remounts a row.

/** Rows mounted when a session opens — several screens even when every row is a one-line tool row. */
export const WINDOW_TAIL_ROWS = 40;
/** Rows added each time the reader nears the top of what is mounted. */
export const WINDOW_STEP_ROWS = 40;
/** Distance (px) from the top of the scroll box at which the next chunk is mounted. */
export const WINDOW_LOAD_MARGIN_PX = 600;

/** First mounted row. A pinned start never passes the tail: the rows can shrink under it (a rewind). */
export function windowStart(total: number, pinned: number | null): number {
  const tail = Math.max(0, total - WINDOW_TAIL_ROWS);
  return pinned === null ? tail : Math.min(pinned, tail);
}

/** Start that mounts `row` with a chunk of context above it. */
function startRevealing(row: number): number {
  return Math.max(0, row - WINDOW_STEP_ROWS);
}

interface ScrollAnchor {
  scrollTop: number;
  scrollHeight: number;
}

export interface TranscriptWindow {
  /** Index of the first mounted row. */
  start: number;
  /** Call from the scroll box's scroll handler. */
  onScroll: () => void;
  /** Mount everything from `row` on; `then` runs once it is in the DOM. */
  reveal: (row: number, then?: () => void) => void;
}

/** Rows mounted above the viewport push the content down; shift the offset by the height they
 *  added so the reader stays on the same line. */
function restoreAnchor(el: HTMLElement | null, anchor: ScrollAnchor | null): void {
  if (el && anchor) el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
}

/** Mounted rows that do not fill the box leave nothing to scroll, so the top can never be reached. */
function underfilled(el: HTMLElement | null, start: number): boolean {
  return !!el && start > 0 && el.clientHeight > 0 && el.scrollHeight <= el.clientHeight;
}

function nearTop(el: HTMLElement | null, start: number): boolean {
  return !!el && start > 0 && el.scrollTop < WINDOW_LOAD_MARGIN_PX;
}

/**
 * `settled` is false while the transcript is still loading: until then the window follows the tail
 * of whatever rows exist (a live row can land before the history does), and only once the history
 * is in does the start stop moving, so rows appended while the reader is scrolled up never shift
 * what they are looking at.
 */
export function useTranscriptWindow({ total, streamKey, settled, scrollRef }: {
  total: number;
  streamKey?: string;
  settled: boolean;
  scrollRef: RefObject<HTMLElement>;
}): TranscriptWindow {
  const [pin, setPin] = useState<{ key?: string; start: number } | null>(null);
  const pinned = pin && pin.key === streamKey ? pin.start : null;
  const start = windowStart(total, pinned);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const afterRef = useRef<(() => void) | null>(null);

  const moveTo = (next: number): void => {
    const el = scrollRef.current;
    if (el) anchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    setPin({ key: streamKey, start: next });
  };
  const growUp = (): void => moveTo(Math.max(0, start - WINDOW_STEP_ROWS));

  useLayoutEffect(() => {
    if (settled && total > 0 && pinned === null) setPin({ key: streamKey, start });
  }, [settled, total, pinned, streamKey, start]);

  useLayoutEffect(() => {
    restoreAnchor(scrollRef.current, anchorRef.current);
    anchorRef.current = null;
    const then = afterRef.current;
    afterRef.current = null;
    then?.();
    if (underfilled(scrollRef.current, start)) growUp();
  }, [start]);

  const onScroll = (): void => {
    if (nearTop(scrollRef.current, start)) growUp();
  };
  const reveal = (row: number, then?: () => void): void => {
    if (row >= start) return then?.();
    afterRef.current = then ?? null;
    moveTo(startRevealing(row));
  };
  return { start, onScroll, reveal };
}
