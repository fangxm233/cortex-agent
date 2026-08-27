// input:  project, session, schedule and thread fixtures with rail UI state
// output: folder-tree bucketing, capping, ordering and filter tests
// pos:    Verifies the left rail's project folder tree view model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type {
  ProjectConduitInfo,
  ScheduleInfo,
  SessionInfo,
  ThreadInfo,
} from '@cortex-agent/ui-contract';
import { buildRailTree, projectOfSession, sessionMatchesFilter, type RailTreeInput } from './rail-tree';

const NOW = Date.parse('2026-07-16T12:00:00');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const project = (id: string): ProjectConduitInfo => ({
  id,
  kind: 'research',
  contextDir: '/ctx/' + id,
  hasMission: true,
  conduits: {},
});

let seq = 0;
const session = (
  projectId: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo =>
  ({
    sessionId: 's' + ++seq,
    projectId,
    name: 'cortex-' + seq,
    label: 'session ' + seq,
    createdAt: ago(DAY),
    lastUsedAt: ago(HOUR),
    origin: 'direct',
    ...overrides,
  }) as SessionInfo;

const thread = (projectId: string, status: ThreadInfo['status']): ThreadInfo =>
  ({
    id: 't' + ++seq,
    templateName: 'coder-review',
    currentStep: null,
    status,
    projectId,
    createdAt: ago(HOUR),
    updatedAt: ago(HOUR),
    totalSteps: 1,
    artifactPath: null,
  }) as ThreadInfo;

const schedule = (id: string, projectId: string): ScheduleInfo =>
  ({
    id,
    type: 'daily',
    message: 'daily check ' + id,
    projectId,
    profile: null,
    nextRun: null,
    lastRun: null,
    paused: false,
    pausedBy: null,
    intervalMs: null,
    time: '07:30',
    dayOfWeek: null,
    target: null,
    fallback: null,
  }) as ScheduleInfo;

const input = (over: Partial<RailTreeInput> = {}): RailTreeInput => ({
  projects: [],
  directSessions: [],
  scheduledSessions: [],
  schedules: [],
  threads: [],
  selectedSessionId: null,
  fallbackProjectId: null,
  expanded: new Set<string>(),
  schedulesExpanded: new Set<string>(),
  showAll: new Set<string>(),
  filter: '',
  sort: 'activity',
  manualOrder: [],
  dragged: false,
  now: NOW,
  ...over,
});

describe('buildRailTree bucketing', () => {
  it('hangs each session under its own project and keeps every project present', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard'), project('atlas')],
        directSessions: [
          session('nimbus', { label: 'n1', lastUsedAt: ago(2 * HOUR) }),
          session('nimbus', { label: 'n2', lastUsedAt: ago(MIN) }),
          session('orchard', { label: 'o1' }),
        ],
        expanded: new Set(['nimbus', 'orchard', 'atlas']),
      }),
    );
    expect(tree.projects.map((p) => p.id)).toEqual(['nimbus', 'orchard', 'atlas']);
    expect(tree.projects[0].sessions.map((s) => s.title)).toEqual(['n2', 'n1']);
    expect(tree.projects[1].sessions.map((s) => s.title)).toEqual(['o1']);
    expect(tree.projects[2].sessions).toEqual([]);
  });

  it('marks a project with no sessions, schedules or running threads as empty', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard'), project('atlas'), project('bramble')],
        directSessions: [session('nimbus')],
        scheduledSessions: [],
        schedules: [schedule('sch1', 'orchard')],
        threads: [thread('atlas', 'running')],
      }),
    );
    const empty = Object.fromEntries(tree.projects.map((p) => [p.id, p.empty]));
    expect(empty).toEqual({ nimbus: false, orchard: false, atlas: false, bramble: true });
  });

  it('sinks projects with no activity to the bottom of the activity order', () => {
    const tree = buildRailTree(
      input({
        projects: [project('quiet'), project('nimbus'), project('orchard')],
        directSessions: [
          session('orchard', { lastUsedAt: ago(3 * DAY) }),
          session('nimbus', { lastUsedAt: ago(MIN) }),
        ],
      }),
    );
    expect(tree.projects.map((p) => p.id)).toEqual(['nimbus', 'orchard', 'quiet']);
  });

  it('counts a scheduled-only project as active for ordering', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard')],
        directSessions: [session('nimbus', { lastUsedAt: ago(2 * DAY) })],
        scheduledSessions: [
          session('orchard', { origin: 'scheduled', scheduleId: 'sch1', lastUsedAt: ago(MIN) }),
        ],
        schedules: [schedule('sch1', 'orchard')],
      }),
    );
    expect(tree.projects.map((p) => p.id)).toEqual(['orchard', 'nimbus']);
  });
});

describe('buildRailTree badges and hotkeys', () => {
  it('merges unread and awaiting-input into one attention count', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus')],
        directSessions: [
          session('nimbus', { unread: true }),
          session('nimbus', { unread: true }),
          session('nimbus', { awaitingInput: true }),
        ],
      }),
    );
    expect(tree.projects[0].attention).toBe(3);
  });

  it('counts running and waiting threads as the blue pulse', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus')],
        threads: [thread('nimbus', 'running'), thread('nimbus', 'waiting'), thread('nimbus', 'completed')],
      }),
    );
    expect(tree.projects[0].running).toBe(2);
  });

  it('assigns ⌘1–9 to non-empty projects only, in visible order', () => {
    const ids = ['a', 'b', 'c'];
    const tree = buildRailTree(
      input({
        projects: [project('empty1'), ...ids.map(project)],
        directSessions: ids.map((id, i) => session(id, { lastUsedAt: ago((i + 1) * HOUR) })),
      }),
    );
    const keys = Object.fromEntries(tree.projects.map((p) => [p.id, p.hotkey]));
    expect(keys).toEqual({ a: '⌘1', b: '⌘2', c: '⌘3', empty1: null });
  });

  it('shows an idle age only when neither a pulse nor a badge is present', () => {
    const tree = buildRailTree(
      input({
        projects: [project('quiet'), project('busy')],
        directSessions: [
          session('quiet', { lastUsedAt: ago(3 * DAY) }),
          session('busy', { unread: true, lastUsedAt: ago(3 * DAY) }),
        ],
      }),
    );
    const byId = Object.fromEntries(tree.projects.map((p) => [p.id, p.idleAge]));
    expect(byId.quiet).toBe('3d');
    expect(byId.busy).toBeNull();
  });
});

describe('buildRailTree session rows', () => {
  it('floats unread sessions above the recency order', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus')],
        directSessions: [
          session('nimbus', { label: 'recent', lastUsedAt: ago(MIN) }),
          session('nimbus', { label: 'old-unread', unread: true, lastUsedAt: ago(2 * DAY) }),
        ],
        expanded: new Set(['nimbus']),
      }),
    );
    expect(tree.projects[0].sessions.map((s) => s.title)).toEqual(['old-unread', 'recent']);
  });

  it('caps a folder and reports what it hid', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus')],
        directSessions: Array.from({ length: 14 }, (_, i) =>
          session('nimbus', { lastUsedAt: ago((i + 1) * MIN) }),
        ),
        expanded: new Set(['nimbus']),
        cap: 8,
      }),
    );
    expect(tree.projects[0].sessions).toHaveLength(8);
    expect(tree.projects[0].hiddenSessions).toBe(6);
    expect(tree.projects[0].totalSessions).toBe(14);
  });

  it('show-all lifts the cap for that project only', () => {
    const many = (id: string) =>
      Array.from({ length: 12 }, (_, i) => session(id, { lastUsedAt: ago((i + 1) * MIN) }));
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard')],
        directSessions: [...many('nimbus'), ...many('orchard')],
        expanded: new Set(['nimbus', 'orchard']),
        showAll: new Set(['nimbus']),
        cap: 8,
      }),
    );
    const byId = Object.fromEntries(tree.projects.map((p) => [p.id, p]));
    expect(byId.nimbus.sessions).toHaveLength(12);
    expect(byId.nimbus.hiddenSessions).toBe(0);
    expect(byId.orchard.sessions).toHaveLength(8);
    // the uncapped folder offers the way back; the capped one still offers the way in
    expect(byId.nimbus.showingAll).toBe(true);
    expect(byId.orchard.showingAll).toBe(false);
  });

  it('does not offer show-fewer when the folder fits under the cap anyway', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus')],
        directSessions: [session('nimbus'), session('nimbus')],
        expanded: new Set(['nimbus']),
        showAll: new Set(['nimbus']),
        cap: 8,
      }),
    );
    expect(tree.projects[0].showingAll).toBe(false);
    expect(tree.projects[0].hiddenSessions).toBe(0);
  });

  it('a filter uncaps without claiming show-all — closing the search is the way back', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus')],
        directSessions: Array.from({ length: 12 }, (_, i) =>
          session('nimbus', { label: 'run ' + i, lastUsedAt: ago((i + 1) * MIN) }),
        ),
        filter: 'run',
        cap: 8,
      }),
    );
    expect(tree.projects[0].sessions).toHaveLength(12);
    expect(tree.projects[0].showingAll).toBe(false);
  });

  it('carries the relative age and the exact stamp for the tooltip', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus')],
        directSessions: [session('nimbus', { lastUsedAt: ago(3 * HOUR) })],
        expanded: new Set(['nimbus']),
      }),
    );
    const row = tree.projects[0].sessions[0];
    expect(row.age).toBe('3h');
    expect(row.stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('falls back from label to name to id for the row title', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus')],
        directSessions: [
          session('nimbus', { sessionId: 'only-id', label: undefined, name: undefined } as never),
        ],
        expanded: new Set(['nimbus']),
      }),
    );
    expect(tree.projects[0].sessions[0].title).toBe('only-id');
  });
});

describe('buildRailTree schedules', () => {
  it('files each schedule under its own project', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard')],
        schedules: [schedule('s-a', 'nimbus'), schedule('s-b', 'orchard'), schedule('s-c', 'nimbus')],
      }),
    );
    const byId = Object.fromEntries(tree.projects.map((p) => [p.id, p.schedules.length]));
    expect(byId).toEqual({ nimbus: 2, orchard: 1 });
  });

  it('files an orphan run group under the project of its session', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard')],
        scheduledSessions: [
          session('orchard', { origin: 'scheduled', scheduleId: 'gone', unread: true }),
        ],
      }),
    );
    const byId = Object.fromEntries(tree.projects.map((p) => [p.id, p]));
    expect(byId.orchard.schedules).toHaveLength(1);
    expect(byId.orchard.schedules[0].schedule).toBeNull();
    expect(byId.orchard.scheduleUnread).toBe(1);
    expect(byId.nimbus.schedules).toHaveLength(0);
  });
});

describe('buildRailTree filtering', () => {
  const filtered = (filter: string) =>
    buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard'), project('atlas')],
        directSessions: [
          session('nimbus', { label: 'redraw the overview figure' }),
          session('nimbus', { label: 'unrelated work' }),
          session('orchard', { label: 'Figure caption pass' }),
          session('atlas', { label: 'nothing to see' }),
        ],
        filter,
      }),
    );

  it('keeps only projects with a hit and reports per-project counts', () => {
    const tree = filtered('figure');
    expect(tree.projects.map((p) => p.id)).toEqual(['nimbus', 'orchard']);
    expect(tree.projects.map((p) => p.matchCount)).toEqual([1, 1]);
    expect(tree.totalMatches).toBe(2);
  });

  it('expands every matching folder and shows all of its hits', () => {
    const tree = filtered('figure');
    expect(tree.projects.every((p) => p.expanded)).toBe(true);
    expect(tree.projects[0].sessions.map((s) => s.title)).toEqual(['redraw the overview figure']);
  });

  it('reports no matches without collapsing to an empty-project list', () => {
    const tree = filtered('zzz');
    expect(tree.projects).toEqual([]);
    expect(tree.totalMatches).toBe(0);
  });

  it('leaves matchCount null when no filter is active', () => {
    const tree = buildRailTree(
      input({ projects: [project('nimbus')], directSessions: [session('nimbus')] }),
    );
    expect(tree.projects[0].matchCount).toBeNull();
    expect(tree.totalMatches).toBeNull();
  });

  it('matches case-insensitively on the session title', () => {
    const s = session('nimbus', { label: 'Redraw Figure' });
    expect(sessionMatchesFilter(s, 'figure')).toBe(true);
    expect(sessionMatchesFilter(s, 'FIGURE')).toBe(true);
    expect(sessionMatchesFilter(s, 'nope')).toBe(false);
    expect(sessionMatchesFilter(s, '')).toBe(true);
  });
});

describe('buildRailTree current project', () => {
  it('derives the current project from the selected session, across origins', () => {
    const direct = session('nimbus');
    const run = session('orchard', { origin: 'scheduled', scheduleId: 'sch1' });
    expect(projectOfSession(direct.sessionId, [direct], [run])).toBe('nimbus');
    expect(projectOfSession(run.sessionId, [direct], [run])).toBe('orchard');
    expect(projectOfSession(null, [direct], [run])).toBeNull();
    expect(projectOfSession('__draft__', [direct], [run])).toBeNull();
  });

  it('marks exactly one folder current and flags the selected row', () => {
    const picked = session('orchard', { label: 'picked' });
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard')],
        directSessions: [session('nimbus'), picked],
        selectedSessionId: picked.sessionId,
        expanded: new Set(['orchard']),
      }),
    );
    expect(tree.currentProjectId).toBe('orchard');
    expect(tree.projects.filter((p) => p.current).map((p) => p.id)).toEqual(['orchard']);
    expect(tree.projects.find((p) => p.id === 'orchard')!.sessions[0].selected).toBe(true);
  });

  it('keeps the fallback project current while the selection owns none (draft session)', () => {
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard')],
        directSessions: [session('nimbus'), session('orchard')],
        selectedSessionId: '__draft__',
        fallbackProjectId: 'orchard',
      }),
    );
    expect(tree.currentProjectId).toBe('orchard');
    expect(tree.projects.filter((p) => p.current).map((p) => p.id)).toEqual(['orchard']);
    expect(tree.projects.flatMap((p) => p.sessions).some((r) => r.selected)).toBe(false);
  });

  it('a resolvable selection outranks the fallback', () => {
    const picked = session('nimbus', { label: 'picked' });
    const tree = buildRailTree(
      input({
        projects: [project('nimbus'), project('orchard')],
        directSessions: [picked],
        selectedSessionId: picked.sessionId,
        fallbackProjectId: 'orchard',
      }),
    );
    expect(tree.currentProjectId).toBe('nimbus');
  });
});

describe('buildRailTree ordering modes', () => {
  const base = {
    projects: [project('nimbus'), project('orchard'), project('atlas')],
    directSessions: [
      session('nimbus', { lastUsedAt: ago(MIN) }),
      session('orchard', { lastUsedAt: ago(HOUR) }),
      session('atlas', { lastUsedAt: ago(DAY) }),
    ],
  };

  it('activity mode ignores the stored manual order', () => {
    const tree = buildRailTree(input({ ...base, manualOrder: ['atlas', 'orchard', 'nimbus'] }));
    expect(tree.projects.map((p) => p.id)).toEqual(['nimbus', 'orchard', 'atlas']);
  });

  it('manual mode follows the stored order', () => {
    const tree = buildRailTree(
      input({ ...base, sort: 'manual', manualOrder: ['atlas', 'orchard', 'nimbus'] }),
    );
    expect(tree.projects.map((p) => p.id)).toEqual(['atlas', 'orchard', 'nimbus']);
  });

  it('activity mode honours an in-session drag until activity resets it', () => {
    const dragged = buildRailTree(
      input({ ...base, manualOrder: ['atlas', 'nimbus', 'orchard'], dragged: true }),
    );
    expect(dragged.projects.map((p) => p.id)).toEqual(['atlas', 'nimbus', 'orchard']);

    const settled = buildRailTree(
      input({ ...base, manualOrder: ['atlas', 'nimbus', 'orchard'], dragged: false }),
    );
    expect(settled.projects.map((p) => p.id)).toEqual(['nimbus', 'orchard', 'atlas']);
  });

  it('manual mode still places a project the stored order never saw', () => {
    const tree = buildRailTree(
      input({ ...base, sort: 'manual', manualOrder: ['atlas', 'nimbus'] }),
    );
    expect(tree.projects.map((p) => p.id)).toEqual(['atlas', 'nimbus', 'orchard']);
  });
});
