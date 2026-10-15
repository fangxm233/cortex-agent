import { describe, expect, it } from 'vitest';
import type { ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { buildRailTree, FOLDER_SESSION_CAP, type RailTreeInput } from './rail-tree';
import { groupWorkers, workersOf } from '@/features/team/worker-groups';

const NOW = Date.parse('2026-07-16T12:00:00');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const project = (id: string): ProjectConduitInfo => ({
  id, kind: 'research', contextDir: '/ctx/' + id, hasMission: true, conduits: {},
});

let seq = 0;
const session = (projectId: string, overrides: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    sessionId: 's' + ++seq,
    projectId,
    label: 'session ' + seq,
    createdAt: ago(5 * HOUR),
    lastUsedAt: ago(HOUR),
    origin: 'direct',
    teamLeadId: null,
    workerName: null,
    ...overrides,
  }) as SessionInfo;

const worker = (lead: SessionInfo, overrides: Partial<SessionInfo> = {}): SessionInfo =>
  session(lead.projectId, { teamLeadId: lead.sessionId, workerName: 'w' + seq, ...overrides });

const input = (over: Partial<RailTreeInput> = {}): RailTreeInput => ({
  projects: [project('atlas')],
  directSessions: [],
  scheduledSessions: [],
  schedules: [],
  selectedSessionId: null,
  fallbackProjectId: null,
  expanded: new Set(['atlas']),
  schedulesExpanded: new Set<string>(),
  showAll: new Set<string>(),
  filter: '',
  sort: 'activity',
  manualOrder: [],
  dragged: false,
  now: NOW,
  lang: 'en',
  ...over,
});

const ids = (rows: { sessionId: string }[]) => rows.map((r) => r.sessionId);

describe('groupWorkers', () => {
  it('nests workers under a present lead and leaves orphans and nested leads flat', () => {
    const lead = session('atlas');
    const w1 = worker(lead);
    const orphan = session('atlas', { teamLeadId: 'gone', workerName: 'x' });
    const sub = worker(w1);
    const g = groupWorkers([lead, w1, orphan, sub]);
    expect(ids(g.top)).toEqual([lead.sessionId, orphan.sessionId, sub.sessionId]);
    expect(ids(g.workers.get(lead.sessionId) ?? [])).toEqual([w1.sessionId]);
    expect(g.workers.has(w1.sessionId)).toBe(false);
  });

  it('orders workers active-first by recency, inactive last', () => {
    const lead = session('atlas');
    const inactive = worker(lead, { lastUsedAt: ago(4 * HOUR) });
    const older = worker(lead, { lastUsedAt: ago(2 * HOUR) });
    const fresh = worker(lead, { lastUsedAt: ago(2 * MIN) });
    // Running is never inactive, however old its last stamp.
    const busy = worker(lead, { lastUsedAt: ago(5 * HOUR), running: true });
    expect(ids(workersOf(lead.sessionId, [lead, inactive, older, fresh, busy], NOW)))
      .toEqual([fresh.sessionId, older.sessionId, busy.sessionId, inactive.sessionId]);
  });
});

describe('rail tree with team mode', () => {
  it('is identical to the plain tree when team mode is off or nobody has workers', () => {
    const lead = session('atlas');
    const plain = [session('atlas'), session('atlas', { lastUsedAt: ago(2 * HOUR) })];
    const withWorkers = [lead, worker(lead), worker(lead), ...plain];
    // Off: worker fields are ignored entirely.
    const off = buildRailTree(input({ directSessions: withWorkers, teamEnabled: false, expandedLeads: new Set([lead.sessionId]) }));
    const stripped = withWorkers.map((s) => ({ ...s, teamLeadId: null, workerName: null }));
    expect(off).toEqual(buildRailTree(input({ directSessions: stripped })));
    // On, but no session has workers: the same tree as without the feature.
    expect(buildRailTree(input({ directSessions: plain, teamEnabled: true })))
      .toEqual(buildRailTree(input({ directSessions: plain })));
  });

  it('nests workers under the lead, collapsed by default, with a rolled-up dot', () => {
    const lead = session('atlas', { lastUsedAt: ago(10 * MIN) });
    const busy = worker(lead, { running: true });
    const asking = worker(lead, { awaitingInput: true });
    const waiting = worker(lead, { waitingOn: 1 });
    const other = session('atlas', { lastUsedAt: ago(20 * MIN) });
    const node = buildRailTree(input({ directSessions: [busy, asking, waiting, lead, other], teamEnabled: true })).projects[0];
    expect(ids(node.sessions)).toEqual([lead.sessionId, other.sessionId]);
    const row = node.sessions[0];
    expect(row.workersExpanded).toBe(false);
    expect(row.workers?.length).toBe(3);
    expect(row).toMatchObject({ running: true, awaitingInput: true, waitingOn: true });
    expect(node.totalSessions).toBe(5);
    expect(node.sessions[1].workers).toBeUndefined();
  });

  it('shows a running worker that waits for its lead\'s answer as plainly running', () => {
    const lead = session('atlas', { lastUsedAt: ago(10 * MIN) });
    const blocked = worker(lead, { running: true, waitingOnLead: 1 });
    const node = buildRailTree(input({
      directSessions: [blocked, lead], teamEnabled: true, expandedLeads: new Set([lead.sessionId]),
    })).projects[0];
    const row = node.sessions[0];
    expect(row).toMatchObject({ running: true, waitingOn: false, awaitingInput: false });
    expect(row.workers?.[0]).toMatchObject({ running: true, waitingOn: false, awaitingInput: false });
  });

  it('rolls unread up only while collapsed and opens for an expanded or selected worker', () => {
    const lead = session('atlas');
    const unread = worker(lead, { unread: true });
    const sessions = [lead, unread];
    const collapsed = buildRailTree(input({ directSessions: sessions, teamEnabled: true })).projects[0].sessions[0];
    expect(collapsed.unread).toBe(true);
    const open = buildRailTree(input({ directSessions: sessions, teamEnabled: true, expandedLeads: new Set([lead.sessionId]) }))
      .projects[0].sessions[0];
    expect(open).toMatchObject({ unread: false, workersExpanded: true });
    expect(open.workers?.[0]).toMatchObject({ sessionId: unread.sessionId, unread: true });
    const selected = buildRailTree(input({ directSessions: sessions, teamEnabled: true, selectedSessionId: unread.sessionId }))
      .projects[0].sessions[0];
    expect(selected.workersExpanded).toBe(true);
    expect(selected.workers?.[0].selected).toBe(true);
  });

  it('marks inactive workers and sorts them last', () => {
    const lead = session('atlas');
    const inactive = worker(lead, { lastUsedAt: ago(4 * HOUR) });
    const active = worker(lead, { lastUsedAt: ago(2 * HOUR) });
    const row = buildRailTree(input({ directSessions: [lead, inactive, active], teamEnabled: true })).projects[0].sessions[0];
    expect(ids(row.workers ?? [])).toEqual([active.sessionId, inactive.sessionId]);
    expect(row.workers?.[0].inactive).toBeUndefined();
    expect(row.workers?.[1].inactive).toBe(true);
  });

  it('keeps a worker flat when its lead is missing or starred', () => {
    const gone = session('atlas', { teamLeadId: 'missing', workerName: 'a' });
    const starredLead = session('atlas', { starred: true });
    const ofStarred = worker(starredLead);
    const node = buildRailTree(input({
      directSessions: [gone, starredLead, ofStarred], teamEnabled: true,
    })).projects[0];
    expect(new Set(ids(node.sessions))).toEqual(new Set([gone.sessionId, ofStarred.sessionId]));
    expect(node.sessions.every((s) => !s.workers)).toBe(true);
    expect(ids(node.starredSessions)).toEqual([starredLead.sessionId]);
  });

  it('counts a lead with its workers as one row against the folder cap', () => {
    const lead = session('atlas', { lastUsedAt: ago(MIN) });
    const workers = Array.from({ length: 4 }, () => worker(lead));
    const loose = Array.from({ length: FOLDER_SESSION_CAP }, (_, i) => session('atlas', { lastUsedAt: ago((i + 2) * MIN) }));
    const node = buildRailTree(input({ directSessions: [lead, ...workers, ...loose], teamEnabled: true })).projects[0];
    expect(node.sessions.length).toBe(FOLDER_SESSION_CAP);
    expect(node.sessions[0].sessionId).toBe(lead.sessionId);
    expect(node.hiddenSessions).toBe(1);
  });

  it('filters into workers, keeping the lead as context and opening it to the hits', () => {
    const lead = session('atlas', { label: 'plan the port' });
    const hit = worker(lead, { label: 'benchmark runner' });
    const miss = worker(lead, { label: 'docs pass' });
    const node = buildRailTree(input({ directSessions: [lead, hit, miss], teamEnabled: true, filter: 'bench' })).projects[0];
    expect(node.matchCount).toBe(1);
    expect(ids(node.sessions)).toEqual([lead.sessionId]);
    expect(node.sessions[0].workersExpanded).toBe(true);
    expect(ids(node.sessions[0].workers ?? [])).toEqual([hit.sessionId]);
  });
});
