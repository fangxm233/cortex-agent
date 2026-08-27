// input:  SessionInfo lists, per-project activity maps and keydown keys
// output: relative ages, the activity order and the ⌘1–9 index
// pos:    Shared project-ordering primitives for the rail tree and mobile
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import type { SessionInfo } from '@cortex-agent/ui-contract';

// The rail's ordering contract: projects sort by MOST RECENT ACTIVITY — the project whose newest
// session activity is latest comes first (see sortProjectsByActivity). Activity derives from the
// persistent session registry (SessionInfo.lastUsedAt), so the order survives server/app restarts and
// never degrades to raw filesystem order. The rail's manual mode (rail-order.ts) layers a stored
// order on top of this one; row assembly itself lives in rail-tree.ts.

/** Compact age label: <1m → 'now', <1h → 'Xm', <24h → 'Xh', else 'Xd'. Never negative. */
export function relativeAge(thenMs: number, nowMs: number): string {
  const span = Math.max(0, nowMs - thenMs);
  if (span < 60_000) return 'now';
  if (span < 3_600_000) return Math.floor(span / 60_000) + 'm';
  if (span < 86_400_000) return Math.floor(span / 3_600_000) + 'h';
  return Math.floor(span / 86_400_000) + 'd';
}

/** Max effective timestamp (lastUsedAt, else createdAt) per project, from an UNSCOPED
 *  sessions.list. Unparseable timestamps are skipped — never fabricate an age. */
export function lastActivityByProject(sessions: SessionInfo[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const s of sessions) {
    const t = Date.parse(s.lastUsedAt || s.createdAt);
    if (Number.isNaN(t)) continue;
    if (!(s.projectId in map) || t > map[s.projectId]) map[s.projectId] = t;
  }
  return map;
}

/** Order projects by most-recent activity (descending): the project whose newest session activity
 *  (from lastActivityByProject) is latest comes first. Projects with no known activity sink to the
 *  bottom, keeping their incoming relative order (stable). Pure — returns a new array, never mutates.
 *  This is the persistent recency sort: lastActivity comes from the persisted session registry, so the
 *  order is stable across server/app restarts (never falls back to raw filesystem order). */
export function sortProjectsByActivity<T extends { id: string }>(
  projects: readonly T[],
  lastActivity: Record<string, number>,
): T[] {
  const val = (id: string): number =>
    typeof lastActivity[id] === 'number' ? lastActivity[id] : -Infinity;
  return [...projects].sort((a, b) => {
    const av = val(a.id);
    const bv = val(b.id);
    if (av === bv) return 0; // ties + both-unknown → stable (keep incoming order)
    return bv - av; // more recent first
  });
}

/** ⌘1–⌘9 keydown → project list index (0–8); anything else → null. */
export function projectIndexFromKey(key: string): number | null {
  if (key.length !== 1 || key < '1' || key > '9') return null;
  return key.charCodeAt(0) - '1'.charCodeAt(0);
}
