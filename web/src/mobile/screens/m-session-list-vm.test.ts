import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { buildSessionGroups, sessionStatusLine } from './m-session-list-vm';

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
  };
}

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
    expect(sessionStatusLine(sess({ waitingOn: 2 })).text).toBe('等 2 个信号');
    // Ranked below everything live and below a pending user action — it asks nothing of the user.
    expect(sessionStatusLine(sess({ waitingOn: 2, running: true })).kind).toBe('running');
    expect(sessionStatusLine(sess({ waitingOn: 2, awaitingInput: true })).kind).toBe('awaiting');
    // An absent field (older server) must not invent a waiting state.
    expect(sessionStatusLine(sess({})).kind).toBe('idle');
  });
});

describe('buildSessionGroups', () => {
  const now = Date.parse('2026-07-15T12:00:00Z');

  it('buckets by day, newest first, drops empty buckets', () => {
    const groups = buildSessionGroups(
      [
        sess({ sessionId: 'a', lastUsedAt: '2026-07-15T11:00:00Z' }),
        sess({ sessionId: 'b', lastUsedAt: '2026-07-14T11:00:00Z' }),
        sess({ sessionId: 'c', lastUsedAt: '2026-07-10T11:00:00Z' }),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(['TODAY', 'YESTERDAY', 'EARLIER']);
    expect(groups[0].rows[0].id).toBe('a');
  });

  it('floats unread sessions first within a day group (reuses groupSessions)', () => {
    const [g] = buildSessionGroups(
      [
        sess({ sessionId: 'a', lastUsedAt: '2026-07-15T11:00:00Z', unread: false }),
        sess({ sessionId: 'b', lastUsedAt: '2026-07-15T10:00:00Z', unread: true }),
      ],
      now,
    );
    // 'b' is older but unread → floats above the read 'a'.
    expect(g.rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
