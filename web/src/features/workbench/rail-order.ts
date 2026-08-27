// input:  project ids, activity timestamps and a persisted manual order
// output: rail sort mode, manual order reconciliation and drag-move
// pos:    Owns the left rail's project ordering rules
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// The rail offers two orders and no third:
//
//   'activity'  — most-recent activity first, recomputed from the session registry on every render.
//   'manual'    — the order the user dragged into place, never recomputed.
//
// BOTH modes accept a drag. The difference is what survives: a manual-mode drag is the order; an
// activity-mode drag applies immediately but is overwritten the next time activity changes, because
// "most recent activity first" is what that mode means. Both write into the SAME persisted array,
// so switching to 'manual' after dragging in 'activity' keeps what you just arranged.

export type RailSortMode = 'activity' | 'manual';

export const RAIL_SORT_KEY = 'cortex.railSort';
export const RAIL_ORDER_KEY = 'cortex.railOrder';

export function isRailSortMode(value: unknown): value is RailSortMode {
  return value === 'activity' || value === 'manual';
}

/** Read the persisted mode; anything unrecognised (or unavailable storage) falls back to activity. */
export function loadSortMode(): RailSortMode {
  try {
    const raw = window.localStorage.getItem(RAIL_SORT_KEY);
    return isRailSortMode(raw) ? raw : 'activity';
  } catch {
    return 'activity';
  }
}

export function saveSortMode(mode: RailSortMode): void {
  try {
    window.localStorage.setItem(RAIL_SORT_KEY, mode);
  } catch {
    /* persistence is best-effort */
  }
}

/** Read the persisted manual order. A malformed payload is treated as "no order yet". */
export function loadManualOrder(): string[] {
  try {
    const raw = window.localStorage.getItem(RAIL_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export function saveManualOrder(order: string[]): void {
  try {
    window.localStorage.setItem(RAIL_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* persistence is best-effort */
  }
}

/**
 * Reconcile a stored manual order against the projects that actually exist.
 *
 * - ids no longer in `activityOrder` are dropped (a deleted project must not hold a slot);
 * - projects missing from the stored order are inserted at their ACTIVITY position rather than
 *   appended, so a brand-new project lands where recency would put it instead of jumping to the
 *   top or sinking to the bottom of a long manual list.
 *
 * `activityOrder` is the id list already sorted by most-recent activity.
 */
export function reconcileManualOrder(stored: readonly string[], activityOrder: readonly string[]): string[] {
  const known = new Set(activityOrder);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of stored) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      kept.push(id);
    }
  }
  // Walk the activity order and splice in anything the stored order never knew about. `anchor`
  // tracks where the previous known-in-both project sits in `kept`, so a new project is inserted
  // directly after the project it currently outranks-or-follows by activity.
  let anchor = 0;
  for (const id of activityOrder) {
    const at = kept.indexOf(id);
    if (at >= 0) {
      anchor = at + 1;
      continue;
    }
    kept.splice(anchor, 0, id);
    anchor += 1;
  }
  return kept;
}

/** Move `draggedId` to the slot currently held by `targetId`. Unknown ids leave the order alone. */
export function moveInOrder(order: readonly string[], draggedId: string, targetId: string): string[] {
  const from = order.indexOf(draggedId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, draggedId);
  return next;
}

/**
 * The order the rail renders.
 *
 * `manual` mode always follows the reconciled manual order. `activity` mode follows activity —
 * unless the user dragged during this session (`dragged`), in which case the drag holds until the
 * next activity change resets it.
 */
export function resolveRailOrder(
  mode: RailSortMode,
  activityOrder: readonly string[],
  manualOrder: readonly string[],
  dragged: boolean,
): string[] {
  if (mode === 'manual' || dragged) return reconcileManualOrder(manualOrder, activityOrder);
  return [...activityOrder];
}
