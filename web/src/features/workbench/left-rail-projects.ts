import type { ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { projectInitials } from './session-groups';

// Pure view-model for the 22a dual-zone left rail PROJECTS zone (scheme.dc.html §22a, L37–150).
// Design contract: project rows are ordered by MOST RECENT ACTIVITY (the project whose newest
// session activity is latest sorts first — see sortProjectsByActivity). Ordering derives from the
// persistent session registry (SessionInfo.lastUsedAt), so it survives server/app restarts and never
// degrades to raw filesystem order. ⌘1–9 follow the visible (activity) order — ⌘1 is the most recently
// active project. A row's trailing slot shows its status badges + hotkey when it has any (mock rows
// TR/LO), else the last-activity age (mock row PP "3d").
// DATA GAP (flagged): the mock's per-row amber "approval pending" dot has no backing field —
// ApprovalInfo carries no projectId — so rows carry running/unread only; the bottom pill stays
// the all-projects aggregate.

export interface ProjectRailRow {
  id: string;
  initials: string;
  active: boolean;
  /** Active thread count (running+waiting) — the blue pulse badge. */
  running: number;
  /** Unread session count — the accent count badge (honest addition, kept from the switcher). */
  unread: number;
  /** '⌘1'…'⌘9' by list order for the first nine rows; null past that or when idleAge shows. */
  hotkey: string | null;
  /** Last-activity age ('3d') — only for badge-less idle rows with a known timestamp. */
  idleAge: string | null;
}

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

/** SESSIONS zone-header project echo (design "quad-nav" from quad-nav-sim2real): the first two
 *  dash/underscore segments; two or fewer segments stay verbatim. */
export function projectShortLabel(id: string): string {
  const segments = id.split(/[-_]/).filter(Boolean);
  if (segments.length <= 2) return id;
  return segments[0] + '-' + segments[1];
}

/** ⌘1–⌘9 keydown → project list index (0–8); anything else → null. */
export function projectIndexFromKey(key: string): number | null {
  if (key.length !== 1 || key < '1' || key > '9') return null;
  return key.charCodeAt(0) - '1'.charCodeAt(0);
}

// Draggable divider bounds. Default = the design's 322px projects-zone cap (~6 rows visible,
// header pinned, rows scroll internally past that).
export const PROJECTS_ZONE_DEFAULT_H = 322;
export const PROJECTS_ZONE_MIN_H = 120;
export const PROJECTS_ZONE_MAX_H = 560;

export function clampProjectsZoneHeight(px: number): number {
  if (!Number.isFinite(px)) return PROJECTS_ZONE_DEFAULT_H;
  return Math.min(PROJECTS_ZONE_MAX_H, Math.max(PROJECTS_ZONE_MIN_H, px));
}

export function buildProjectRailRows(
  projects: ProjectConduitInfo[],
  activeId: string | null,
  runningCounts: Record<string, number>,
  unreadCounts: Record<string, number>,
  lastActivity: Record<string, number>,
  nowMs: number,
): ProjectRailRow[] {
  return projects.map((p, i) => {
    const active = p.id === activeId;
    const running = runningCounts[p.id] ?? 0;
    const unread = unreadCounts[p.id] ?? 0;
    const hasBadge = running > 0 || unread > 0;
    const activityMs = lastActivity[p.id];
    // The active row never shows an age — its trailing sub-line carries the ⌘k echo instead.
    const idleAge =
      !active && !hasBadge && typeof activityMs === 'number' ? relativeAge(activityMs, nowMs) : null;
    return {
      id: p.id,
      initials: projectInitials(p.id),
      active,
      running,
      unread,
      hotkey: idleAge === null && i < 9 ? '⌘' + (i + 1) : null,
      idleAge,
    };
  });
}
