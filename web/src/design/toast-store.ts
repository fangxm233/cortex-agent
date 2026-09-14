import type { Tone } from './tone';

// Pure queue logic for the ONE on-screen bubble stack (design §5 + scheme 18a). Framework-agnostic
// and deterministic so it can be unit-tested without a DOM; the React `ToastProvider` in Toast.tsx
// owns id generation and `ToastViewport` owns timers, both delegating to these.
//
// This queue is shared by the two sources that used to own a stack each:
//   · imperative action feedback — `useToast()` call sites (settings writes, downloads, updates…);
//   · the live notification feed — DM turn replies and server `system.notice` events
//     (features/notifications), which push through the same `toast()` with a richer payload.
// The list holds live items newest-last; the viewport shows the newest MAX_VISIBLE and folds the
// rest into a "+N" pill (scheme 18a: 向上堆叠最多 3 条，溢出折叠为「+N」胶囊).

/** Severity of a bubble — drives icon glyph/colour. `tone` (the public call-site vocabulary) maps
 *  onto this via TONE_LEVEL; feed items pass their server-classified level straight through. */
export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/** Tone → level. Tones are the app-wide status vocabulary (design tone.ts); levels are what a
 *  bubble renders. `cancelled` is not a failure, so it reads as neutral info. */
export const TONE_LEVEL: Record<Tone, ToastLevel> = {
  running: 'info',
  waiting: 'warning',
  done: 'success',
  failed: 'error',
  cancelled: 'info',
};

/** An optional action button rendered inside a bubble (e.g. the download toast's "Open file" /
 *  "Open folder"). Clicking it runs `onClick` and dismisses the bubble. */
export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Screen-reader alternative for the action; defaults to `label`. */
  altText?: string;
}

export interface ToastItem {
  id: string;
  level: ToastLevel;
  title: string;
  /** One-line mono body (action detail, or the feed's message preview). */
  description?: string;
  /** ISO-8601 timestamp used for the mono age slot. */
  ts: string;
  /** Milliseconds until auto-dismiss; `Infinity` stays resident until dismissed. */
  duration: number;
  actions?: ToastAction[];
  /** Click-through on the bubble body (feed items navigate to their session). Absent = inert body. */
  onActivate?: () => void;
  /** Consecutive-duplicate key: an item whose key equals the current newest item's key is dropped
   *  (e.g. a transcript refetch echoing an already-shown message). Undefined never dedupes. */
  dedupeKey?: string;
}

/** Hard cap on retained bubbles so the list can't grow unbounded across a long session. */
export const RETAIN_CAP = 50;

/** Max bubbles rendered before the rest collapse into a "+N" pill (scheme 18a). */
export const MAX_VISIBLE = 3;

/** Append `item` newest-last. Drops a consecutive duplicate of the current newest; trims the oldest
 *  beyond `cap`. Never mutates the input. */
export function addToast(list: ToastItem[], item: ToastItem, cap = RETAIN_CAP): ToastItem[] {
  const last = list[list.length - 1];
  if (last && item.dedupeKey !== undefined && last.dedupeKey === item.dedupeKey) return list;
  const next = [...list, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Remove a bubble by id. No-op for an unknown id. Never mutates the input. */
export function removeToast(list: ToastItem[], id: string): ToastItem[] {
  return list.filter((t) => t.id !== id);
}

/** Split into the newest `max` (rendered, oldest-of-visible first → newest last) and the count of
 *  older ones folded into the "+N" pill. */
export function splitVisible(
  list: ToastItem[],
  max = MAX_VISIBLE,
): { visible: ToastItem[]; overflow: number } {
  if (list.length <= max) return { visible: list, overflow: 0 };
  return { visible: list.slice(list.length - max), overflow: list.length - max };
}

/** Compact relative age ("now" / "2m" / "1h") for the mono time slot (scheme 18a). */
export function relativeAge(ts: string, now: number = Date.now()): string {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return 'now';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
