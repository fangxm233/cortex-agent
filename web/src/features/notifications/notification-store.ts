import type { NotificationItem } from './notification-vm';

// Pure notification-queue logic (design 18a). Framework-agnostic and deterministic so it can be
// unit-tested without a DOM; the React `NotificationToaster` owns id/timers and delegates here.
//
// The list holds all live notifications newest-last. The toaster shows the newest MAX_VISIBLE
// stacked upward from the bottom-right corner; anything older collapses into a "+N" pill
// (scheme 18a: 向上堆叠最多 3 条，溢出折叠为「+N」胶囊).

/** Max bubbles rendered before the rest collapse into a "+N" pill (scheme 18a). */
export const MAX_VISIBLE = 3;

/** Hard cap on retained notifications so the list can't grow unbounded across a long session. */
export const RETAIN_CAP = 50;

/** Consecutive-duplicate key: the same session re-posting the same preview text (e.g. a
 *  transcript refetch echoing an already-toasted message) is dropped. */
function sameContent(a: NotificationItem, b: NotificationItem): boolean {
  return a.sessionId === b.sessionId && a.meta === b.meta;
}

/** Append `item` newest-last. Drops a consecutive duplicate of the current newest; trims the
 *  oldest beyond RETAIN_CAP. Never mutates the input. */
export function addNotification(list: NotificationItem[], item: NotificationItem): NotificationItem[] {
  const last = list[list.length - 1];
  if (last && sameContent(last, item)) return list;
  const next = [...list, item];
  return next.length > RETAIN_CAP ? next.slice(next.length - RETAIN_CAP) : next;
}

/** Remove a notification by id. No-op for an unknown id. Never mutates the input. */
export function removeNotification(list: NotificationItem[], id: string): NotificationItem[] {
  return list.filter((n) => n.id !== id);
}

/** Split into the newest `max` (rendered, oldest-of-visible first → newest last) and the count of
 *  older ones folded into the "+N" pill. */
export function splitVisible(
  list: NotificationItem[],
  max = MAX_VISIBLE,
): { visible: NotificationItem[]; overflow: number } {
  if (list.length <= max) return { visible: list, overflow: 0 };
  return { visible: list.slice(list.length - max), overflow: list.length - max };
}
