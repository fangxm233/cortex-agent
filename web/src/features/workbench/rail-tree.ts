// input:  project/session/schedule/thread DTOs plus rail UI state
// output: one flat list of project folder nodes with their session and schedule rows
// pos:    Pure view model behind the left rail's project folder tree
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ProjectConduitInfo, ScheduleInfo, SessionInfo, ThreadInfo } from '@cortex-agent/ui-contract';
import { buildScheduleRows, unreadScheduleCount, type ScheduleRow } from './schedule-rail';
import { lastActivityByProject, relativeAge, sortProjectsByActivity } from './left-rail-projects';
import {
  awaitingInputCountByProject,
  projectAttentionBadge,
  runningCountByProject,
  unreadCountByProject,
  type ProjectAttentionBadgeTone,
} from './project-menu';
import { resolveRailOrder, type RailSortMode } from './rail-order';

// The rail is ONE flat list of project folders — every project is present, none is folded away
// behind an "other projects" group. Projects with nothing in them sink to the bottom by activity
// (they have no activity timestamp) and render dimmed, but stay expandable and stay a valid target
// for "new session here". Sessions hang under their own project, so several projects can be open
// at once; that is the whole point of the tree over the previous two-zone rail.

/** How many sessions a folder shows before it offers "show all". */
export const FOLDER_SESSION_CAP = 8;

export interface RailSessionRow {
  sessionId: string;
  projectId: string;
  title: string;
  /** Compact relative age ('now' / '5m' / '3h' / '2d'); the exact stamp goes in the row tooltip. */
  age: string;
  /** Full local timestamp for the row's title attribute. */
  stamp: string;
  running: boolean;
  awaitingInput: boolean;
  unread: boolean;
  selected: boolean;
}

export interface RailProjectNode {
  id: string;
  /** The project holding the selected session — the rail's only notion of "current". */
  current: boolean;
  expanded: boolean;
  /** No sessions, no schedules and no running threads: rendered dimmed, sorted last. */
  empty: boolean;
  /** Active thread count (running + waiting) — the blue pulse. */
  running: number;
  /** Unread + awaiting-input sessions, in one badge. */
  attention: number;
  /** 'action' when any session is actually blocked on you (amber), else 'unread' (accent). */
  attentionTone: ProjectAttentionBadgeTone;
  /** '⌘1'…'⌘9' by visible order, non-empty projects only; null past nine or when an age shows. */
  hotkey: string | null;
  /** Last-activity age, only for quiet rows that show neither badge nor pulse. */
  idleAge: string | null;
  sessions: RailSessionRow[];
  /** Sessions this project has beyond the ones in `sessions`. */
  hiddenSessions: number;
  /** Uncapped by an explicit "show all" that is still holding back rows — offer the way out. */
  showingAll: boolean;
  totalSessions: number;
  schedules: ScheduleRow[];
  schedulesExpanded: boolean;
  scheduleUnread: number;
  /** Sessions matching the active filter; null when no filter is active. */
  matchCount: number | null;
}

export interface RailTreeInput {
  projects: ProjectConduitInfo[];
  directSessions: SessionInfo[];
  scheduledSessions: SessionInfo[];
  schedules: ScheduleInfo[];
  threads: ThreadInfo[];
  selectedSessionId: string | null;
  /** Project to call current while the selection owns none — a draft session, or none at all. */
  fallbackProjectId: string | null;
  expanded: ReadonlySet<string>;
  schedulesExpanded: ReadonlySet<string>;
  showAll: ReadonlySet<string>;
  /** Free-text session filter; empty string means no filter. */
  filter: string;
  sort: RailSortMode;
  manualOrder: readonly string[];
  /** True while an in-session drag overrides the activity order. */
  dragged: boolean;
  now: number;
  cap?: number;
}

export interface RailTree {
  projects: RailProjectNode[];
  /** Project owning the selected session — what the rest of the workbench scopes to. */
  currentProjectId: string | null;
  /** Total sessions matching the filter across every project; null when no filter is active. */
  totalMatches: number | null;
}

function effectiveMs(s: SessionInfo): number {
  const t = Date.parse(s.lastUsedAt || s.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Full local stamp for the row tooltip — the tree itself only shows the relative age. */
export function sessionTooltipStamp(s: SessionInfo): string {
  const ms = effectiveMs(s);
  if (!ms) return '';
  const d = new Date(ms);
  return (
    d.getFullYear() +
    '-' + pad2(d.getMonth() + 1) +
    '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) +
    ':' + pad2(d.getMinutes())
  );
}

export function sessionTitle(s: SessionInfo): string {
  return s.label ?? s.name ?? s.sessionId;
}

/** Case-insensitive substring match over the session title. */
export function sessionMatchesFilter(s: SessionInfo, filter: string): boolean {
  if (!filter) return true;
  return sessionTitle(s).toLowerCase().includes(filter.toLowerCase());
}

/** Unread first, then most recent — the order inside every folder. */
function orderSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort(
    (a, b) => Number(!!b.unread) - Number(!!a.unread) || effectiveMs(b) - effectiveMs(a),
  );
}

function groupByProject(sessions: SessionInfo[]): Map<string, SessionInfo[]> {
  const map = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const list = map.get(s.projectId);
    if (list) list.push(s);
    else map.set(s.projectId, [s]);
  }
  return map;
}

/** The project owning a session id, across both direct and scheduled sessions. */
export function projectOfSession(
  sessionId: string | null,
  directSessions: SessionInfo[],
  scheduledSessions: SessionInfo[],
): string | null {
  if (!sessionId) return null;
  const hit =
    directSessions.find((s) => s.sessionId === sessionId) ??
    scheduledSessions.find((s) => s.sessionId === sessionId);
  return hit?.projectId ?? null;
}

export function buildRailTree(input: RailTreeInput): RailTree {
  const {
    projects, directSessions, scheduledSessions, schedules, threads,
    selectedSessionId, fallbackProjectId, expanded, schedulesExpanded, showAll,
    sort, manualOrder, dragged, now,
  } = input;
  const cap = input.cap ?? FOLDER_SESSION_CAP;
  const filter = input.filter.trim();
  const filtering = filter.length > 0;

  const runningCounts = runningCountByProject(threads);
  const unreadCounts = unreadCountByProject(directSessions);
  const actionCounts = awaitingInputCountByProject(directSessions);
  // Activity spans BOTH origins: a project whose only life is a scheduled run still has a place in
  // the recency order rather than sinking in with the never-used ones.
  const lastActivity = lastActivityByProject([...directSessions, ...scheduledSessions]);

  const sessionsByProject = groupByProject(directSessions);
  const scheduledByProject = groupByProject(scheduledSessions);
  const schedulesByProject = new Map<string, ScheduleInfo[]>();
  for (const schedule of schedules) {
    const list = schedulesByProject.get(schedule.projectId);
    if (list) list.push(schedule);
    else schedulesByProject.set(schedule.projectId, [schedule]);
  }

  const activityOrder = sortProjectsByActivity(projects, lastActivity).map((p) => p.id);
  const order = resolveRailOrder(sort, activityOrder, manualOrder, dragged);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const orderedProjects = order.map((id) => byId.get(id)).filter((p): p is ProjectConduitInfo => !!p);

  // A draft session belongs to no project yet, and an empty workbench has no selection at all. In
  // both cases the folder the user last acted in stays lit, because that is where the next message
  // will land — "New session" with nothing highlighted would hide which project it targets.
  const currentProjectId =
    projectOfSession(selectedSessionId, directSessions, scheduledSessions) ?? fallbackProjectId;

  let hotkeyIndex = 0;
  let totalMatches = 0;
  const nodes: RailProjectNode[] = orderedProjects.map((project) => {
    const own = sessionsByProject.get(project.id) ?? [];
    const scheduleRows = buildScheduleRows(
      schedulesByProject.get(project.id) ?? [],
      scheduledByProject.get(project.id) ?? [],
      now,
    );
    const running = runningCounts[project.id] ?? 0;
    // The badge counts both, but its COLOUR only ever means one thing: amber = something is waiting
    // on you. Unread replies are news, not a request, so they stay accent — collapsing the two into
    // one alarm colour makes the real asks stop registering.
    const badge = projectAttentionBadge(unreadCounts[project.id] ?? 0, actionCounts[project.id] ?? 0);
    const attention = badge.count;
    const empty = own.length === 0 && scheduleRows.length === 0 && running === 0;

    const matching = filtering ? own.filter((s) => sessionMatchesFilter(s, filter)) : own;
    if (filtering) totalMatches += matching.length;

    // A filter expands every folder that has a hit and shows all of them — capping a search result
    // would hide the very row the user is looking for.
    const rows = orderSessions(matching);
    const uncapped = showAll.has(project.id);
    const visible = filtering || uncapped ? rows : rows.slice(0, cap);

    const activityMs = lastActivity[project.id];
    const hasSignal = running > 0 || attention > 0;
    const hotkey = !empty && hotkeyIndex < 9 ? '⌘' + ++hotkeyIndex : null;

    return {
      id: project.id,
      current: project.id === currentProjectId,
      expanded: filtering ? matching.length > 0 : expanded.has(project.id),
      empty,
      running,
      attention,
      attentionTone: badge.tone,
      hotkey,
      idleAge:
        !hasSignal && typeof activityMs === 'number' ? relativeAge(activityMs, now) : null,
      sessions: visible.map((s) => ({
        sessionId: s.sessionId,
        projectId: s.projectId,
        title: sessionTitle(s),
        age: relativeAge(effectiveMs(s), now),
        stamp: sessionTooltipStamp(s),
        running: !!s.running,
        awaitingInput: !!s.awaitingInput,
        unread: !!s.unread,
        selected: s.sessionId === selectedSessionId,
      })),
      hiddenSessions: Math.max(0, rows.length - visible.length),
      // A filter uncaps the folder on its own, so it offers no "show fewer" — closing the search is
      // the way back from that one.
      showingAll: uncapped && !filtering && rows.length > cap,
      totalSessions: own.length,
      schedules: scheduleRows,
      schedulesExpanded: schedulesExpanded.has(project.id),
      scheduleUnread: unreadScheduleCount(scheduleRows),
      matchCount: filtering ? matching.length : null,
    };
  });

  return {
    projects: filtering ? nodes.filter((n) => (n.matchCount ?? 0) > 0) : nodes,
    currentProjectId,
    totalMatches: filtering ? totalMatches : null,
  };
}
