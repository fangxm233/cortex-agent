import type {
  ProjectConduitInfo, ScheduleInfo, SessionInfo,
} from '@cortex-agent/ui-contract';
import { shortSessionId } from '@/features/session/metadata/short-session-id';
import { buildScheduleRows, unreadScheduleCount, type ScheduleRow } from '@/features/session/list/schedule-rail';
import { leadRow, workerRow } from './worker-rail';
import { groupWorkers } from '@/features/team/worker-groups';
import { sessionRollup } from '@/features/team/worker-rollup';
import { lastActivityByProject, sortProjectsByActivity } from '@/features/session/list/left-rail-projects';
import { partitionStarredSessions } from '@/features/session/list/starred-sessions';
import { effectiveMs, orderSessions } from '@/features/session/list/session-groups';
import {
  awaitingInputCountByProject,
  projectAttentionBadge,
  unreadCountByProject,
  type ProjectAttentionBadgeTone,
} from '@/features/session/list/project-menu';
import { resolveRailOrder, type RailSortMode } from './rail-order';
import { clockTime, relTime, type TimeLang } from '@/i18n/time-format';

// The rail is ONE flat list of project folders — every project is present, none is folded away
// behind an "other projects" group. Projects with nothing in them sink to the bottom by activity
// (they have no activity timestamp) and render dimmed, but stay expandable and stay a valid target
// for "new session here". Sessions hang under their own project, so several projects can be open
// at once; that is the whole point of the tree over the previous two-zone rail.

/** How many sessions a folder shows before it offers "show all". */
export const FOLDER_SESSION_CAP = 8;

export interface RailSessionRow {
  sessionId: string;
  starred?: boolean;
  projectId: string;
  title: string;
  /** Compact relative age in the UI language ('now' / '5m' · '刚刚' / '5分钟前'); the exact stamp goes in the row tooltip. */
  age: string;
  /** Full local timestamp for the row's title attribute. */
  stamp: string;
  running: boolean;
  awaitingInput: boolean;
  /** Waiting on an external signal (an armed waitpoint). Deliberately NOT folded into
   *  `awaitingInput`: that one means "blocked on you", this one means "blocked on a machine". */
  waitingOn: boolean;
  unread: boolean;
  selected: boolean;
  /** Team mode only: a retired worker — sorted last, rendered dimmed. */
  retired?: boolean;
  /** Team mode only: this lead's workers, nested under it. Absent when it has none to show. */
  workers?: RailSessionRow[];
  workersExpanded?: boolean;
}

export interface RailProjectNode {
  id: string;
  /** The project holding the selected session — the rail's only notion of "current". */
  current: boolean;
  expanded: boolean;
  /** No sessions and no schedules: rendered dimmed, sorted last. */
  empty: boolean;
  /** Unread + awaiting-input sessions, in one badge. */
  attention: number;
  /** 'action' when any session is actually blocked on you (amber), else 'unread' (accent). */
  attentionTone: ProjectAttentionBadgeTone;
  /** '⌘1'…'⌘9' by visible order, non-empty projects only; null past nine or when an age shows. */
  hotkey: string | null;
  /** Last-activity age, only for quiet rows that show no badge. */
  idleAge: string | null;
  starredSessions: RailSessionRow[];
  starsExpanded: boolean;
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
  selectedSessionId: string | null;
  /** Project to call current while the selection owns none — a draft session, or none at all. */
  fallbackProjectId: string | null;
  expanded: ReadonlySet<string>;
  schedulesExpanded: ReadonlySet<string>;
  /** Project-local Stars sections are open unless explicitly collapsed. */
  starsCollapsed?: ReadonlySet<string>;
  showAll: ReadonlySet<string>;
  /** Team mode: nest workers under their lead. Off ⇒ every session is a plain row. */
  teamEnabled?: boolean;
  /** Lead sessions whose worker list is open — keyed by session id. */
  expandedLeads?: ReadonlySet<string>;
  /** Free-text session filter; empty string means no filter. */
  filter: string;
  sort: RailSortMode;
  manualOrder: readonly string[];
  /** True while an in-session drag overrides the activity order. */
  dragged: boolean;
  now: number;
  lang: TimeLang;
}

export interface RailTree {
  projects: RailProjectNode[];
  /** Project owning the selected session — what the rest of the workbench scopes to. */
  currentProjectId: string | null;
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
    ' ' + clockTime(d)
  );
}

export function sessionTitle(s: SessionInfo): string {
  return s.label ?? shortSessionId(s.sessionId);
}

/** Case-insensitive substring match over the session title. */
export function sessionMatchesFilter(s: SessionInfo, filter: string): boolean {
  if (!filter) return true;
  return sessionTitle(s).toLowerCase().includes(filter.toLowerCase());
}

function groupByProject<T extends { projectId: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const s of items) {
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
    projects, directSessions, scheduledSessions, schedules,
    selectedSessionId, fallbackProjectId, expanded, schedulesExpanded, showAll,
    sort, manualOrder, dragged, now, lang,
  } = input;
  const toSessionRow = (s: SessionInfo): RailSessionRow => ({
    sessionId: s.sessionId,
    projectId: s.projectId,
    title: sessionTitle(s),
    starred: s.starred,
    age: relTime(effectiveMs(s), now, lang),
    stamp: sessionTooltipStamp(s),
    // running / awaitingInput / waitingOn / unread, in the dot language the lead rolls up.
    ...sessionRollup(s),
    selected: s.sessionId === selectedSessionId,
  });
  const filter = input.filter.trim();
  const filtering = filter.length > 0;

  const unreadCounts = unreadCountByProject(directSessions);
  const actionCounts = awaitingInputCountByProject(directSessions);
  // Activity spans BOTH origins: a project whose only life is a scheduled run still has a place in
  // the recency order rather than sinking in with the never-used ones.
  const lastActivity = lastActivityByProject([...directSessions, ...scheduledSessions]);

  const sessionsByProject = groupByProject(directSessions);
  const scheduledByProject = groupByProject(scheduledSessions);
  const schedulesByProject = groupByProject(schedules);

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
  const nodes: RailProjectNode[] = orderedProjects.map((project) => {
    const partition = partitionStarredSessions(
      sessionsByProject.get(project.id) ?? [], scheduledByProject.get(project.id) ?? [],
    );
    const own = partition.direct;
    const matchingStars = partition.starred.filter((s) => sessionMatchesFilter(s, filter));
    // Team mode: workers hang under their lead and count as part of its row, so the folder cap and
    // ordering see one row per lead.
    const nesting = input.teamEnabled ? groupWorkers(own) : null;
    const workersOf = (s: SessionInfo): SessionInfo[] => nesting?.workers.get(s.sessionId) ?? [];
    const scheduleRows = buildScheduleRows(
      schedulesByProject.get(project.id) ?? [],
      partition.scheduled,
    );
    // The badge counts both, but its COLOUR only ever means one thing: amber = something is waiting
    // on you. Unread replies are news, not a request, so they stay accent — collapsing the two into
    // one alarm colour makes the real asks stop registering.
    const badge = projectAttentionBadge(unreadCounts[project.id] ?? 0, actionCounts[project.id] ?? 0);
    const attention = badge.count;
    const empty =
      partition.starred.length === 0 && own.length === 0 && scheduleRows.length === 0;

    const ownMatches = filtering ? own.filter((s) => sessionMatchesFilter(s, filter)).length : own.length;
    // A lead stays in a filtered list while any of its workers matches — the hit nests under it.
    const matching = !nesting
      ? filtering ? own.filter((s) => sessionMatchesFilter(s, filter)) : own
      : filtering
        ? nesting.top.filter((s) =>
          sessionMatchesFilter(s, filter) || workersOf(s).some((w) => sessionMatchesFilter(w, filter)))
        : nesting.top;
    const toTopRow = (s: SessionInfo): RailSessionRow => {
      const workers = workersOf(s);
      if (workers.length === 0) return toSessionRow(s);
      const all = workers.map((w) => workerRow(w, toSessionRow));
      const shown = filtering ? all.filter((_, i) => sessionMatchesFilter(workers[i], filter)) : all;
      // Open while filtering (the hits must be visible) and while a worker is the selection.
      const expandedLead = filtering || !!input.expandedLeads?.has(s.sessionId) ||
        workers.some((w) => w.sessionId === selectedSessionId);
      return leadRow(toSessionRow(s), all, shown, expandedLead);
    };

    // A filter expands every folder that has a hit and shows all of them — capping a search result
    // would hide the very row the user is looking for.
    const rows = orderSessions(matching);
    const uncapped = showAll.has(project.id);
    const visible = filtering || uncapped ? rows : rows.slice(0, FOLDER_SESSION_CAP);

    const activityMs = lastActivity[project.id];
    const hasSignal = attention > 0;
    const hotkey = !empty && hotkeyIndex < 9 ? '⌘' + ++hotkeyIndex : null;

    return {
      id: project.id,
      current: project.id === currentProjectId,
      expanded: filtering
        ? ownMatches + matchingStars.length > 0
        : expanded.has(project.id),
      empty,
      attention,
      attentionTone: badge.tone,
      hotkey,
      idleAge:
        !hasSignal && typeof activityMs === 'number' ? relTime(activityMs, now, lang) : null,
      starredSessions: orderSessions(matchingStars).map(toSessionRow),
      starsExpanded: filtering || !input.starsCollapsed?.has(project.id),
      sessions: visible.map(toTopRow),
      hiddenSessions: Math.max(0, rows.length - visible.length),
      // A filter uncaps the folder on its own, so it offers no "show fewer" — closing the search is
      // the way back from that one.
      showingAll: uncapped && !filtering && rows.length > FOLDER_SESSION_CAP,
      totalSessions: own.length,
      schedules: scheduleRows,
      schedulesExpanded: schedulesExpanded.has(project.id),
      scheduleUnread: unreadScheduleCount(scheduleRows),
      matchCount: filtering ? ownMatches + matchingStars.length : null,
    };
  });

  return {
    projects: filtering ? nodes.filter((n) => (n.matchCount ?? 0) > 0) : nodes,
    currentProjectId,
  };
}
