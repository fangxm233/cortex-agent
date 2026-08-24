// input:  backend label + native tool name + raw TodoWrite input
// output: parseTodoWrite → TodoSnapshot, and renderTodoProgress for one-line surfaces
// pos:    Backend-neutral TodoWrite payload normalization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Backend } from '../types.js';
import type { TodoItem, TodoSnapshot, TodoStatus } from './event-types.js';
import { matchesCanonicalAnyBackend, toCanonical } from './tool-names.js';

const STATUSES: ReadonlySet<string> = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Unknown or missing status counts as `pending`: a malformed entry must never be silently
 *  reported as done, which would overstate progress on every surface. */
function asStatus(value: unknown): TodoStatus {
  return typeof value === 'string' && STATUSES.has(value) ? (value as TodoStatus) : 'pending';
}

function asItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const content = asString(record['content']).trim();
  // activeForm is required by both backends' schemas, but a model can still omit it; falling back
  // to `content` keeps the in-progress label populated rather than rendering an empty line.
  const activeForm = asString(record['activeForm']).trim() || content;
  if (!content && !activeForm) return null;
  return { content: content || activeForm, activeForm, status: asStatus(record['status']) };
}

/**
 * Build a snapshot from a raw TodoWrite input payload.
 *
 * Returns null when the payload is not a task list at all — that is indistinguishable from the
 * call never happening, which is the correct degradation: a malformed TodoWrite must not break a
 * turn. An explicitly empty list IS a valid snapshot (`total: 0`); it means the agent cleared its
 * plan, and the surfaces hide themselves rather than keeping a stale list on screen.
 */
export function parseTodoSnapshot(input: unknown, now: number = Date.now()): TodoSnapshot | null {
  if (!input || typeof input !== 'object') return null;
  const raw = (input as Record<string, unknown>)['todos'];
  if (!Array.isArray(raw)) return null;

  const items: TodoItem[] = [];
  for (const entry of raw) {
    const item = asItem(entry);
    if (item) items.push(item);
  }

  let completed = 0;
  let activeLabel: string | null = null;
  for (const item of items) {
    if (item.status === 'completed') completed += 1;
    // First in-progress item wins. Models occasionally mark two at once; picking the first is
    // stable and never throws, where asserting exactly one would fail on real traffic.
    else if (item.status === 'in_progress' && activeLabel === null) activeLabel = item.activeForm;
  }

  return { items, total: items.length, completed, activeLabel, updatedAt: now };
}

/** Snapshot for a tool call, or null when this call is not a TodoWrite. */
export function parseTodoWrite(
  backend: Backend,
  nativeName: string,
  input: unknown,
  now: number = Date.now(),
): TodoSnapshot | null {
  if (toCanonical(backend, nativeName) !== 'todo_write') return null;
  return parseTodoSnapshot(input, now);
}

/** Same as parseTodoWrite for callers that do not know their backend — see
 *  matchesCanonicalAnyBackend for why the name alone is sufficient. */
export function parseTodoWriteByName(
  nativeName: string,
  input: unknown,
  now: number = Date.now(),
): TodoSnapshot | null {
  if (!matchesCanonicalAnyBackend(nativeName, 'todo_write')) return null;
  return parseTodoSnapshot(input, now);
}

/** Compact one-line progress used by the platform status line, the TUI, and history summaries.
 *  Empty string when there is nothing to show, so callers can concatenate unconditionally. */
export function renderTodoProgress(snapshot: TodoSnapshot | null, maxLabel = 40): string {
  if (!snapshot || snapshot.total === 0) return '';
  const counts = `${snapshot.completed}/${snapshot.total}`;
  const label = snapshot.activeLabel?.trim();
  if (!label) return counts;
  const short = label.length > maxLabel ? `${label.slice(0, maxLabel - 1).trimEnd()}…` : label;
  return `${counts} · ${short}`;
}
