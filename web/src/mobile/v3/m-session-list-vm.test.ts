import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { buildSessionGroups, sessionStatusLine } from './m-session-list-vm';

// Neutral placeholder sessions (守则11 — no real project names / ids).
function sess(over: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 's1',
    name: 'morning review',
    projectId: 'nimbus',
    backend: 'anthropic',
    kind: 'local',
    origin: 'direct',
    createdAt: '2026-07-15T09:00:00Z',
    lastUsedAt: '2026-07-15T09:00:00Z',
    resumable: true,
    label: null,
    profileName: null,
    running: false,
    numTurns: null,
    unread: false,
    ...over,
  };
}

describe('sessionStatusLine', () => {
  it('running with a turn count → `running · N turns`', () => {
    expect(sessionStatusLine(sess({ running: true, numTurns: 12 }))).toEqual({
      kind: 'running',
      text: 'running · 12 turns',
    });
  });

  it('running without a turn count → bare `running` (no fabricated turns)', () => {
    expect(sessionStatusLine(sess({ running: true, numTurns: null }))).toEqual({
      kind: 'running',
      text: 'running',
    });
  });

  it('idle → 空闲 (no fabricated cost — SessionInfo carries none)', () => {
    expect(sessionStatusLine(sess({ running: false }))).toEqual({ kind: 'idle', text: '空闲' });
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

  it('prefers label over name for the row title', () => {
    const [g] = buildSessionGroups([sess({ label: 'ablation planning', name: 'x' })], now);
    expect(g.rows[0].title).toBe('ablation planning');
  });

  it('carries real turn count + running flag onto the row', () => {
    const [g] = buildSessionGroups([sess({ running: true, numTurns: 4 })], now);
    expect(g.rows[0]).toMatchObject({ running: true, numTurns: 4 });
  });
});
