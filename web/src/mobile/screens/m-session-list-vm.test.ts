import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { teamContext } from '@/features/team/worker-groups';
import { buildProjectSessionList, buildSessionRows, sessionStatusLine } from './m-session-list-vm';
import { en, zh } from '@/i18n';

// Neutral placeholder sessions (守则11 — no real project names / ids).
function sess(over: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 's1',
    backendSessionId: null,
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
    boardId: over.boardId ?? null,
    teamLeadId: over.teamLeadId ?? null,
    workerName: over.workerName ?? null,
  };
}

describe('project session list stars', () => {
  it('scopes Stars to the project and excludes stars from flat and scheduled rows', () => {
    const direct = [sess({ sessionId: 'legacy' }),
      sess({ sessionId: 'bound', boardId: 'b1', starred: true, label: 'Renamed' }),
      sess({ sessionId: 'elsewhere', projectId: 'atlas', starred: true })];
    const runs = [sess({ sessionId: 'run', origin: 'scheduled', scheduleId: 'sch', starred: true }),
      sess({ sessionId: 'old-run', origin: 'scheduled', scheduleId: 'sch' })];
    const list = buildProjectSessionList('nimbus', direct, runs, []);
    expect(list.rows.map(r => r.id)).toEqual(['legacy']);
    expect(list.rows[0].title).toBe('legacy');
    expect(list.starredRows.map(r => r.id)).toEqual(['bound', 'run']);
    expect(list.starredRows[0].title).toBe('Renamed');
    expect(list.scheduleRows[0].runs.map(r => r.sessionId)).toEqual(['old-run']);
    const restored = buildProjectSessionList('nimbus', direct.map(s => ({ ...s, starred: false })),
      runs.map(s => ({ ...s, starred: false })), []);
    expect(restored.starredRows).toEqual([]);
    expect(restored.rows.map(r => r.id)).toEqual(['legacy', 'bound']);
    expect(restored.scheduleRows[0].runs.map(r => r.sessionId)).toEqual(['run', 'old-run']);
  });

  it('uses a short UUID for an unlabeled session', () => {
    const rows = buildSessionRows([sess({ sessionId: 'abcdef12-3456-7890-abcd-ef1234567890' })], Date.now(), 'en', en);
    expect(rows[0].title).toBe('abcdef12');
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
    expect(sessionStatusLine(sess({ waitingOn: 2 }), zh).text).toBe('等 2 个信号');
    expect(sessionStatusLine(sess({ waitingOn: 2 }), en).text).toBe('Waiting on 2 signals');
    // Ranked below everything live and below a pending user action — it asks nothing of the user.
    expect(sessionStatusLine(sess({ waitingOn: 2, running: true })).kind).toBe('running');
    expect(sessionStatusLine(sess({ waitingOn: 2, awaitingInput: true })).kind).toBe('awaiting');
    // An absent field (older server) must not invent a waiting state.
    expect(sessionStatusLine(sess({})).kind).toBe('idle');
  });

  it('shows a worker waiting for its lead\'s answer as plainly running', () => {
    expect(sessionStatusLine(sess({ running: true, waitingOnLead: 1 }), zh).kind).toBe('running');
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
    expect(buildSessionRows([row], now, 'en', en)[0]).toMatchObject({ time: '4h', status: { text: 'Running · 3 turns' } });
    expect(buildSessionRows([row], now, 'zh', zh)[0]).toMatchObject({ time: '4小时前', status: { text: '运行中 · 3 轮' } });
  });
});

describe('team workers in the session list', () => {
  const lead = sess({ sessionId: 'lead', lastUsedAt: '2026-07-15T10:00:00Z' });
  const active = sess({ sessionId: 'w-active', teamLeadId: 'lead', workerName: 'a', lastUsedAt: '2026-07-15T09:15:00Z' });
  // Idle past the fold age (3h) at `now`.
  const inactive = sess({ sessionId: 'w-inactive', teamLeadId: 'lead', workerName: 'b', lastUsedAt: '2026-07-15T07:00:00Z' });
  const orphan = sess({ sessionId: 'orphan', teamLeadId: 'gone', workerName: 'c', lastUsedAt: '2026-07-15T09:30:00Z' });
  const now = Date.parse('2026-07-15T12:00:00Z');

  it('leaves out workers whose lead is listed, keeps orphans as rows', () => {
    const rows = buildSessionRows([active, lead, inactive, orphan], now, 'en', en, true);
    expect(rows.map(r => r.id)).toEqual(['lead', 'orphan']);
    expect(rows[0]).toMatchObject({ unread: false, status: { kind: 'idle' } });
  });

  it('shows an idle lead as running while a worker runs, and counts them', () => {
    const second = sess({ sessionId: 'w-2', teamLeadId: 'lead', workerName: 'd', running: true });
    const one = buildSessionRows([lead, { ...active, running: true }], now, 'en', en, true);
    expect(one[0].status).toEqual({ kind: 'running', text: '1 worker running' });
    const two = buildSessionRows([lead, { ...active, running: true }, second], now, 'zh', zh, true);
    expect(two[0].status).toEqual({ kind: 'running', text: '2 个 worker 运行中' });
  });

  it('keeps the lead’s own line within a tier, and puts a worker blocked on the user above a run', () => {
    const runningLead = { ...lead, running: true, numTurns: 4 };
    expect(buildSessionRows([runningLead, { ...active, running: true }], now, 'en', en, true)[0].status)
      .toEqual({ kind: 'running', text: 'Running · 4 turns' });
    expect(buildSessionRows([runningLead, { ...active, awaitingInput: true }], now, 'en', en, true)[0].status)
      .toEqual({ kind: 'awaiting', text: 'A worker needs your input' });
    expect(buildSessionRows([{ ...lead, awaitingInput: true }, { ...active, awaitingInput: true }], now, 'en', en, true)[0].status)
      .toEqual({ kind: 'awaiting', text: 'Needs your input' });
  });

  it('rolls a worker waiting for its lead\'s answer up as a run', () => {
    const onLead = { ...active, running: true, waitingOnLead: 1 };
    expect(buildSessionRows([lead, onLead], now, 'en', en, true)[0].status.kind).toBe('running');
  });

  it('rolls up unread from workers, but nothing from inactive ones, which the lead’s chat does not offer', () => {
    expect(buildSessionRows([lead, { ...active, unread: true }], now, 'en', en, true)[0].unread).toBe(true);
    const dormant = { ...inactive, unread: true };
    expect(buildSessionRows([lead, dormant], now, 'en', en, true)[0]).toMatchObject({ unread: false, status: { kind: 'idle' } });
  });

  it('keeps a starred lead’s workers off both lists and rolls them onto the starred row', () => {
    const starredLead = { ...lead, starred: true };
    const list = buildProjectSessionList('nimbus', [starredLead, { ...active, running: true }, inactive, orphan], [], [], now, 'en', en, true);
    expect(list.starredRows.map(r => r.id)).toEqual(['lead']);
    expect(list.starredRows[0].status).toEqual({ kind: 'running', text: '1 worker running' });
    expect(list.rows.map(r => r.id)).toEqual(['orphan']);
  });

  it('still hands the hidden workers to the lead’s chat for its worker strip', () => {
    const sessions = [lead, active, inactive];
    expect(buildProjectSessionList('nimbus', sessions, [], [], now, 'en', en, true).rows.map(r => r.id)).toEqual(['lead']);
    expect(teamContext(true, lead, sessions).workers.map(w => w.sessionId)).toEqual(['w-active', 'w-inactive']);
  });

  it('is the plain flat list when team mode is off', () => {
    const sessions = [active, lead, inactive, orphan];
    const off = buildProjectSessionList('nimbus', sessions, [], [], now, 'en', en, false);
    const plain = buildProjectSessionList('nimbus',
      sessions.map(s => ({ ...s, teamLeadId: null, workerName: null })), [], [], now, 'en', en);
    expect(off).toEqual(plain);
    expect(off.rows.map(r => r.id)).toEqual(['lead', 'orphan', 'w-active', 'w-inactive']);
    const on = buildProjectSessionList('nimbus', sessions, [], [], now, 'en', en, true);
    expect(on.rows.map(r => r.id)).toEqual(['lead', 'orphan']);
  });
});
