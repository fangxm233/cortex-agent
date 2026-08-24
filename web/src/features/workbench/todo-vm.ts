// input:  persisted/live task-list snapshots and raw SSE payloads
// output: validated snapshot resolution plus rail row and label models
// pos:    shared task-list model; surfaces own their visibility policy
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { TodoItem, TodoSnapshot, TodoStatus } from '@cortex-agent/ui-contract';

export interface TodoRowViewModel {
  key: string;
  /** In-progress rows read as the present-continuous form; everything else as the imperative. */
  text: string;
  status: TodoStatus;
  /** False on the last row, which must not draw a connector tail below itself. */
  hasTail: boolean;
}

export interface TodoRailViewModel {
  /** `3/7`, always monospace at the call site. */
  counts: string;
  /** What the agent says it is doing now, or null when nothing is in progress. */
  activeLabel: string | null;
  /** True once every item is complete — the rail switches from accent to success. */
  allDone: boolean;
  rows: TodoRowViewModel[];
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

export function resolveTodos(
  live: TodoSnapshot | null,
  snapshot: TodoSnapshot | null | undefined,
): TodoSnapshot | null {
  return live ?? snapshot ?? null;
}

/**
 * Validate a `session.todos` payload into a snapshot, or null when it is not one.
 *
 * The counters travel on the wire rather than being re-derived here: they are part of the
 * contract, and a client that recomputed them would silently diverge from the platform status
 * line the moment either side changed its definition of "done".
 */
export function todoSnapshotFromLivePayload(payload: unknown): TodoSnapshot | null {
  if (!payload || typeof payload !== 'object') return null;
  const snapshot = (payload as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = snapshot as Record<string, unknown>;
  if (!Array.isArray(value.items)) return null;
  if (!isCount(value.total) || !isCount(value.completed) || !isCount(value.updatedAt)) return null;
  if (value.activeLabel !== null && typeof value.activeLabel !== 'string') return null;

  const items: TodoItem[] = [];
  for (const raw of value.items) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.content !== 'string' || typeof item.activeForm !== 'string') return null;
    if (!STATUSES.includes(item.status as TodoStatus)) return null;
    items.push({ content: item.content, activeForm: item.activeForm, status: item.status as TodoStatus });
  }
  return {
    items,
    total: value.total as number,
    completed: value.completed as number,
    activeLabel: (value.activeLabel as string | null) ?? null,
    updatedAt: value.updatedAt as number,
  };
}

/** Null when there is nothing worth showing, so the surface can render nothing at all rather than
 *  an empty bar taking up permanent height above the composer. */
export function todoRailViewModel(snapshot: TodoSnapshot | null): TodoRailViewModel | null {
  if (!snapshot || snapshot.total === 0) return null;
  const rows = snapshot.items.map((item, index) => ({
    key: `${index}:${item.content}`,
    text: item.status === 'in_progress' ? item.activeForm : item.content,
    status: item.status,
    hasTail: index < snapshot.items.length - 1,
  }));
  return {
    counts: `${snapshot.completed}/${snapshot.total}`,
    activeLabel: snapshot.activeLabel,
    allDone: snapshot.completed >= snapshot.total,
    rows,
  };
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
