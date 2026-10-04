import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { teamContext } from '@/features/team/worker-groups';
import { buildProjectSessionList, buildSessionRows, sessionStatusLine } from './m-session-list-vm';

// Neutral placeholder sessions (守则11 — no real project names / ids).
function sess(over: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 's1',
    backendSessionId: null,
    name: 'morning review',
    projectId: 'nimbus',
    backend: 'claude',
    kind: 'local',
    origin: 'direct',
    createdAt: '2026-07-15T09:00:00Z',
    lastUsedAt: '2026-07-15T09:00:00Z',
    resumable: true,
    label: null,
    profileName: null,
    running: false,
    backgroundRunning: false,
    awaitingInput: false,
    numTurns: null,
    costUsd: null,
    unread: false,
    scheduleId: null,
    ...over,
    commissionId: over.commissionId ?? null,
    teamLeadId: over.teamLeadId ?? null,
    workerName: over.workerName ?? null,
    workerRetiredAt: over.workerRetiredAt ?? null,
  };
}

describe('project session list stars', () => {
  it('scopes Stars to the project and excludes stars from flat and scheduled rows', () => {
    const direct = [sess({ sessionId: 'legacy' }),
      sess({ sessionId: 'commission', commissionId: 'c1', starred: true, label: 'Renamed' }),
      sess({ sessionId: 'elsewhere', projectId: 'atlas', starred: true })];
    const runs = [sess({ sessionId: 'run', origin: 'scheduled', scheduleId: 'sch', starred: true }),
      sess({ sessionId: 'old-run', origin: 'scheduled', scheduleId: 'sch' })];
    const list = buildProjectSessionList('nimbus', direct, runs, []);
    expect(list.rows.map(r => r.id)).toEqual(['legacy']);
    expect(list.starredRows.map(r => r.id)).toEqual(['commission', 'run']);
    expect(list.starredRows[0].title).toBe('Renamed');
    expect(list.scheduleRows[0].runs.map(r => r.sessionId)).toEqual(['old-run']);
    const restored = buildProjectSessionList('nimbus', direct.map(s => ({ ...s, starred: false })),
      runs.map(s => ({ ...s, starred: false })), []);
    expect(restored.starredRows).toEqual([]);
    expect(restored.rows.map(r => r.id)).toEqual(['legacy', 'commission']);
    expect(restored.scheduleRows[0].runs.map(r => r.sessionId)).toEqual(['run', 'old-run']);
  });

  it('does not create a global Stars section without a selected project', () => {
    const list = buildProjectSessionList(null, [sess({ starred: true })], [], []);
    expect(list.starredRows).toEqual([]);
    expect(list.rows.map(r => r.id)).toEqual(['s1']);
  });
});

describe('sessionStatusLine', () => {
  it('classifies running, idle, background-held, and awaiting sessions', () => {
    expect(sessionStatusLine(sess({ running: true, numTurns: 12 })).kind).toBe('running');
    expect(sessionStatusLine(sess({ running: false })).kind).toBe('idle');
    expect(sessionStatusLine(sess({ running: true, backgroundRunning: true })).kind).toBe('background');
    expect(sessionStatusLine(sess({ running: true, awaitingInput: true })).kind).toBe('awaiting');
  });

  it('awaiting wins over background (blocked on a question while a bg task holds)', () => {
    expect(
      sessionStatusLine(sess({ running: true, backgroundRunning: true, awaitingInput: true })).kind,
    ).toBe('awaiting');
  });

  it('separates "idle" from "idle but waiting on an external signal"', () => {
    expect(sessionStatusLine(sess({ waitingOn: 2 })).kind).toBe('waiting-external');
    expect(sessionStatusLine(sess({ waitingOn: 2 }), 'zh').text).toBe('等 2 个信号');
    expect(sessionStatusLine(sess({ waitingOn: 2 }), 'en').text).toBe('Waiting on 2 signals');
    // Ranked below everything live and below a pending user action — it asks nothing of the user.
    expect(sessionStatusLine(sess({ waitingOn: 2, running: true })).kind).toBe('running');
    expect(sessionStatusLine(sess({ waitingOn: 2, awaitingInput: true })).kind).toBe('awaiting');
    // An absent field (older server) must not invent a waiting state.
    expect(sessionStatusLine(sess({})).kind).toBe('idle');
  });

  it('shows a worker blocked on its lead as waiting on the lead, even while its turn runs', () => {
    expect(sessionStatusLine(sess({ running: true, waitingOnLead: 1 }), 'zh')).toEqual({ kind: 'waiting-external', text: '等待主会话' });
    expect(sessionStatusLine(sess({ waitingOnLead: 1 }), 'en').text).toBe('Waiting on lead');
    expect(sessionStatusLine(sess({ waitingOnLead: 1, awaitingInput: true })).kind).toBe('awaiting');
  });
});

describe('buildSessionRows', () => {
  const now = Date.parse('2026-07-15T12:00:00Z');

  it('lists every session in one run, most recent first, across days', () => {
    const rows = buildSessionRows(
      [
        sess({ sessionId: 'c', lastUsedAt: '2026-07-10T11:00:00Z' }),
        sess({ sessionId: 'a', lastUsedAt: '2026-07-15T11:00:00Z' }),
        sess({ sessionId: 'b', lastUsedAt: '2026-07-14T11:00:00Z' }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('floats unread sessions first, like a desktop rail folder', () => {
    const rows = buildSessionRows(
      [
        sess({ sessionId: 'a', lastUsedAt: '2026-07-15T11:00:00Z', unread: false }),
        sess({ sessionId: 'b', lastUsedAt: '2026-07-12T10:00:00Z', unread: true }),
      ],
      now,
    );
    // 'b' is days older but unread → floats above the read 'a'.
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('labels status and relative time in the UI language', () => {
    const row = sess({ running: true, numTurns: 3, lastUsedAt: '2026-07-15T08:00:00Z' });
    expect(buildSessionRows([row], now, 'en')[0]).toMatchObject({ time: '4h', status: { text: 'Running · 3 turns' } });
    expect(buildSessionRows([row], now, 'zh')[0]).toMatchObject({ time: '4小时前', status: { text: '运行中 · 3 轮' } });
  });
});

describe('team workers in the session list', () => {
  const lead = sess({ sessionId: 'lead', lastUsedAt: '2026-07-15T10:00:00Z' });
  const active = sess({ sessionId: 'w-active', teamLeadId: 'lead', workerName: 'a', lastUsedAt: '2026-07-15T08:00:00Z' });
  const retired = sess({ sessionId: 'w-retired', teamLeadId: 'lead', workerName: 'b',
    lastUsedAt: '2026-07-15T11:00:00Z', workerRetiredAt: Date.parse('2026-07-15T11:00:00Z') });
  const orphan = sess({ sessionId: 'orphan', teamLeadId: 'gone', workerName: 'c', lastUsedAt: '2026-07-15T09:30:00Z' });
  const now = Date.parse('2026-07-15T12:00:00Z');

  it('leaves out workers whose lead is listed, keeps orphans as rows', () => {
    const rows = buildSessionRows([active, lead, retired, orphan], now, 'en', true);
    expect(rows.map(r => r.id)).toEqual(['lead', 'orphan']);
    expect(rows[0]).toMatchObject({ unread: false, status: { kind: 'idle' } });
  });

  it('shows an idle lead as running while a worker runs, and counts them', () => {
    const second = sess({ sessionId: 'w-2', teamLeadId: 'lead', workerName: 'd', running: true });
    const one = buildSessionRows([lead, { ...active, running: true }], now, 'en', true);
    expect(one[0].status).toEqual({ kind: 'running', text: '1 worker running' });
    const two = buildSessionRows([lead, { ...active, running: true }, second], now, 'zh', true);
    expect(two[0].status).toEqual({ kind: 'running', text: '2 个 worker 运行中' });
  });

  it('keeps the lead’s own line within a tier, and puts a worker blocked on the user above a run', () => {
    const runningLead = { ...lead, running: true, numTurns: 4 };
    expect(buildSessionRows([runningLead, { ...active, running: true }], now, 'en', true)[0].status)
      .toEqual({ kind: 'running', text: 'Running · 4 turns' });
    expect(buildSessionRows([runningLead, { ...active, awaitingInput: true }], now, 'en', true)[0].status)
      .toEqual({ kind: 'awaiting', text: 'A worker needs your input' });
    expect(buildSessionRows([{ ...lead, awaitingInput: true }, { ...active, awaitingInput: true }], now, 'en', true)[0].status)
      .toEqual({ kind: 'awaiting', text: 'Needs your input' });
  });

  it('shows a waiting worker as a wait on the lead, not as a run', () => {
    const onLead = { ...active, running: true, waitingOnLead: 1 };
    expect(buildSessionRows([lead, onLead], now, 'en', true)[0].status)
      .toEqual({ kind: 'waiting-external', text: '1 worker waiting' });
  });

  it('rolls up unread from workers, but nothing from retired ones, which the lead’s chat does not offer', () => {
    expect(buildSessionRows([lead, { ...active, unread: true }], now, 'en', true)[0].unread).toBe(true);
    const dormant = { ...retired, unread: true, running: true };
    expect(buildSessionRows([lead, dormant], now, 'en', true)[0]).toMatchObject({ unread: false, status: { kind: 'idle' } });
  });

  it('keeps a starred lead’s workers off both lists and rolls them onto the starred row', () => {
    const starredLead = { ...lead, starred: true };
    const list = buildProjectSessionList('nimbus', [starredLead, { ...active, running: true }, retired, orphan], [], [], now, 'en', true);
    expect(list.starredRows.map(r => r.id)).toEqual(['lead']);
    expect(list.starredRows[0].status).toEqual({ kind: 'running', text: '1 worker running' });
    expect(list.rows.map(r => r.id)).toEqual(['orphan']);
  });

  it('still hands the hidden workers to the lead’s chat for its worker strip', () => {
    const sessions = [lead, active, retired];
    expect(buildProjectSessionList('nimbus', sessions, [], [], now, 'en', true).rows.map(r => r.id)).toEqual(['lead']);
    expect(teamContext(true, lead, sessions).workers.map(w => w.sessionId)).toEqual(['w-active', 'w-retired']);
  });

  it('is the plain flat list when team mode is off', () => {
    const sessions = [active, lead, retired, orphan];
    const off = buildProjectSessionList('nimbus', sessions, [], [], now, 'en', false);
    const plain = buildProjectSessionList('nimbus',
      sessions.map(s => ({ ...s, teamLeadId: null, workerName: null, workerRetiredAt: null })), [], [], now, 'en');
    expect(off).toEqual(plain);
    expect(off.rows.map(r => r.id)).toEqual(['w-retired', 'lead', 'orphan', 'w-active']);
    const on = buildProjectSessionList('nimbus', sessions, [], [], now, 'en', true);
    expect(on.rows.map(r => r.id)).toEqual(['lead', 'orphan']);
  });
});
