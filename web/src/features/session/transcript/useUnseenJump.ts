import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type { ChatRow } from './chat-row';
import { advanceVisit, newVisit, unseenTarget, type ReadMark, type UnseenTarget, type Visit } from './unseen';
import type { StickToBottom } from './useStickToBottom';
import type { TranscriptWindow } from './useTranscriptWindow';
import { useWorkLogMode } from './work-log-pref';

// The stream side of the unseen replies (see unseen.ts): rows on screen count as seen, the target
// is above or below the view, and the jump puts the target where a fresh screen would start.
// Replies publish their row index as `data-chat-row`.

/** A reply counts as seen once this much of it — all of it, if shorter — has been on screen. */
const SEEN_PX = 32;

export interface UnseenJumpTarget extends UnseenTarget {
  /** The reply is above what the reader is looking at. */
  above: boolean;
}

export interface UnseenJump {
  target: UnseenJumpTarget | null;
  /** Part of the scroller's onScroll. */
  onScroll: () => void;
  jump: () => void;
}

export interface UnseenJumpOptions {
  rows: ChatRow[];
  /** The foreground turn is running. */
  live: boolean;
  /** The transcript has been fetched since the session was opened. */
  fetched: boolean;
  streamKey?: string;
  /** Undefined until the session list has answered. */
  mark?: ReadMark;
  scrollRef: RefObject<HTMLElement>;
  contentRef: RefObject<HTMLElement>;
  stick: StickToBottom;
  win: TranscriptWindow;
  /** Height a floating composer covers at the bottom of the scroller. */
  coverBottom?: number;
}

interface Band { top: number; bottom: number }

function viewBand(el: HTMLElement, coverBottom: number): Band {
  const box = el.getBoundingClientRect();
  return { top: box.top, bottom: Math.max(box.top, box.bottom - coverBottom) };
}

function onScreen(node: HTMLElement, band: Band): boolean {
  const r = node.getBoundingClientRect();
  return Math.min(r.bottom, band.bottom) - Math.max(r.top, band.top) >= Math.min(r.height, SEEN_PX);
}

/** Marks the candidate rows on screen as seen; true when any was new. */
function markSeen(el: HTMLElement, v: Visit, band: Band): boolean {
  let changed = false;
  el.querySelectorAll<HTMLElement>('[data-chat-row]').forEach((node) => {
    const row = Number(node.dataset.chatRow);
    if (!v.candidates.has(row) || v.seen.has(row) || !onScreen(node, band)) return;
    v.seen.add(row);
    changed = true;
  });
  return changed;
}

/** An unmounted target sits above the mounted window. */
function isAbove(el: HTMLElement, row: number, band: Band): boolean {
  const node = el.querySelector<HTMLElement>(`[data-chat-row="${row}"]`);
  return !node || node.getBoundingClientRect().bottom <= band.top;
}

/** A pinned view that is not at the bottom yet is about to be moved there: what it shows now was
 *  never in front of the reader. */
function settling(el: HTMLElement, stick: StickToBottom): boolean {
  return stick.pinned() && el.scrollHeight - el.scrollTop - el.clientHeight > 1;
}

function scrollToRow(el: HTMLElement | null, content: HTMLElement | null, row: number): void {
  const node = el?.querySelector<HTMLElement>(`[data-chat-row="${row}"]`);
  if (!el || !node) return;
  // The content's own top padding: where a fresh screen of transcript starts.
  const margin = content ? parseFloat(getComputedStyle(content).paddingTop) || 0 : 0;
  // Instant, so the replies the jump passes over do not flash by as seen.
  el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - margin;
}

function useVisit(o: UnseenJumpOptions): MutableRefObject<Visit> {
  const ref = useRef<Visit>(newVisit(o.streamKey));
  if (ref.current.key !== o.streamKey) ref.current = newVisit(o.streamKey);
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  advanceVisit(ref.current, { rows: o.rows, fetched: o.fetched, mark: o.mark, away: !o.stick.pinned() || hidden });
  return ref;
}

/** Reads the view at most once a frame. */
function useFrame(read: () => void): () => void {
  const raf = useRef(0);
  useEffect(() => () => {
    if (raf.current && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf.current);
  }, []);
  return useCallback(() => {
    if (typeof requestAnimationFrame === 'undefined') return read();
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      read();
    });
  }, [read]);
}

export function useUnseenJump(o: UnseenJumpOptions): UnseenJump {
  const visit = useVisit(o);
  const workOpen = useWorkLogMode() === 'expanded';
  const [, setSeenTick] = useState(0);
  const [above, setAbove] = useState(true);
  const target = unseenTarget(visit.current, o.rows, { live: o.live, workOpen });
  const now = useRef({ row: target?.row ?? null, cover: o.coverBottom ?? 0, stick: o.stick });
  now.current = { row: target?.row ?? null, cover: o.coverBottom ?? 0, stick: o.stick };

  const read = useCallback(() => {
    const el = o.scrollRef.current;
    const { row, cover, stick } = now.current;
    if (!el || row === null || settling(el, stick)) return;
    const band = viewBand(el, cover);
    if (markSeen(el, visit.current, band)) setSeenTick((t) => t + 1);
    setAbove(isAbove(el, row, band));
  }, [o.scrollRef, visit]);
  const schedule = useFrame(read);
  // Rows landing or the target moving can change what is on screen without a scroll.
  useEffect(schedule, [schedule, o.rows, target?.row, o.win.start]);

  const jump = (): void => {
    if (!target) return;
    o.stick.release();
    o.win.reveal(target.row, () => scrollToRow(o.scrollRef.current, o.contentRef.current, target.row));
  };
  return { target: target && { ...target, above }, onScroll: schedule, jump };
}
