// input:  Ink stdin event emitter (raw input chunks)
// output: Unified mouse handler — wheel scroll, text selection, right-click
// pos:    Handles all SGR mouse events for the M5 Ink TUI
//
// SGR mouse tracking is enabled in index.tsx (enterFullscreen writes `?1002h;?1006h`). With
// ?1002h (button-event tracking), the terminal sends motion events ONLY while a button is held
// (drag), plus press/release. This hook decodes all SGR events from Ink's internal emitter and
// dispatches to the appropriate callback: wheel scroll, selection (left-drag), or right-click.

import { useEffect, useRef, useState } from 'react';
import { useStdin } from 'ink';
import { parseAllMouseEvents } from '../logic.js';
import { createNumericBatcher, createThrottle, type NumericBatcher, type Throttled } from '../raf-batch.js';

export interface SelectionRange {
  startRow: number; startCol: number; // screen coordinates, 0-based
  endRow: number; endCol: number;
}

export interface UseMouseHandlerOpts {
  onScrollUp: () => void;
  onScrollDown: () => void;
  /** Apply a coalesced wheel scroll in ONE update (delta>0 = up, <0 = down). Preferred over the unit callbacks. */
  onScrollByLines?: (delta: number) => void;
  onSelectionComplete?: (range: SelectionRange) => void;
  onRightClick?: () => void;
}

// Cap drag-selection re-renders at ~one per frame (60fps) while still landing the final position.
const DRAG_THROTTLE_MS = 16;

export function useMouseHandler(opts: UseMouseHandlerOpts): { selection: SelectionRange | null } {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Selection state: active means a left-button drag is in progress
  const dragRef = useRef<{ active: boolean; startRow: number; startCol: number; endRow: number; endCol: number }>({
    active: false, startRow: 0, startCol: 0, endRow: 0, endCol: 0,
  });
  // React state for rendering (updated on drag/release to trigger re-render)
  const [selection, setSelection] = useState<SelectionRange | null>(null);

  // Coalesce wheel notches: a burst of wheel events (often several per stdin chunk) sums into one
  // scroll update instead of one re-render per notch. Lazily created once, reads opts via the ref.
  const scrollBatchRef = useRef<NumericBatcher | null>(null);
  if (scrollBatchRef.current === null) {
    scrollBatchRef.current = createNumericBatcher((sum) => {
      const o = optsRef.current;
      if (o.onScrollByLines) { o.onScrollByLines(sum); return; }
      // Fallback when no batched handler is wired: replay the unit callbacks.
      const n = Math.abs(sum);
      for (let i = 0; i < n; i++) (sum > 0 ? o.onScrollUp : o.onScrollDown)();
    });
  }

  // Throttle drag-selection re-renders (the dragRef itself is always updated synchronously so the
  // release still reads the exact end position).
  const selThrottleRef = useRef<Throttled<[SelectionRange]> | null>(null);
  if (selThrottleRef.current === null) {
    selThrottleRef.current = createThrottle((range: SelectionRange) => setSelection(range), DRAG_THROTTLE_MS);
  }

  const emitter = (useStdin() as unknown as { internal_eventEmitter?: NodeJS.EventEmitter }).internal_eventEmitter;

  useEffect(() => {
    if (!emitter) return;
    const onChunk = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const evt of parseAllMouseEvents(s)) {
        if (evt.type === 'wheel') {
          // Accumulate notches (up = +1, down = -1); the batcher applies the net delta once.
          scrollBatchRef.current!.add((evt.button & 1) === 0 ? 1 : -1);
          continue;
        }
        if (evt.type === 'press' && evt.button === 0) {
          // Left press: start selection
          dragRef.current = { active: true, startRow: evt.row, startCol: evt.col, endRow: evt.row, endCol: evt.col };
          selThrottleRef.current!.cancel(); // drop any pending trailing update
          setSelection(null); // clear any previous selection highlight
          continue;
        }
        if (evt.type === 'drag' && evt.button === 0 && dragRef.current.active) {
          // Left drag: update the end position synchronously, but throttle the render update.
          dragRef.current.endRow = evt.row;
          dragRef.current.endCol = evt.col;
          selThrottleRef.current!.call({
            startRow: dragRef.current.startRow, startCol: dragRef.current.startCol,
            endRow: evt.row, endCol: evt.col,
          });
          continue;
        }
        if (evt.type === 'release' && evt.button === 0 && dragRef.current.active) {
          // Left release: finalize selection
          dragRef.current.active = false;
          const { startRow, startCol } = dragRef.current;
          const endRow = evt.row, endCol = evt.col;
          // Only emit if the selection spans more than a single click (drag distance > 0)
          if (startRow !== endRow || startCol !== endCol) {
            optsRef.current.onSelectionComplete?.({ startRow, startCol, endRow, endCol });
          }
          // Cancel any pending throttled update so it can't overwrite the final range, then set it.
          selThrottleRef.current!.cancel();
          setSelection({ startRow, startCol, endRow, endCol });
          continue;
        }
        if (evt.type === 'press' && evt.button === 2) {
          optsRef.current.onRightClick?.();
          continue;
        }
      }
    };
    emitter.on('input', onChunk);
    return () => {
      emitter.removeListener('input', onChunk);
      scrollBatchRef.current?.cancel();
      selThrottleRef.current?.cancel();
    };
  }, [emitter]);

  return { selection };
}
