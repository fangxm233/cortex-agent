import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { deriveMostRecentSessionId, resolveSelectedSessionId } from './selected-session';

function sess(id: string, lastUsedAt: string, projectId = 'p1'): SessionInfo {
  return {
    sessionId: id, backendSessionId: null, name: id, projectId, backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: lastUsedAt, lastUsedAt, resumable: true, label: null, profileName: null, running: false, backgroundRunning: false, numTurns: null, costUsd: null, unread: false,
  };
}

const sessions = [
  sess('a', '2026-05-01T00:00:00Z'),
  sess('b', '2026-05-10T00:00:00Z'),
  sess('c', '2026-05-05T00:00:00Z'),
];

describe('deriveMostRecentSessionId', () => {
  it('picks the most-recently-used session', () => {
    expect(deriveMostRecentSessionId(sessions)).toBe('b');
  });
  it('returns null for an empty list', () => {
    expect(deriveMostRecentSessionId([])).toBeNull();
  });
});

describe('resolveSelectedSessionId', () => {
  it('honors an override that is still in the list', () => {
    expect(resolveSelectedSessionId('a', sessions)).toBe('a');
  });
  it('falls back to most-recent when the override left the list (e.g. after a project switch)', () => {
    expect(resolveSelectedSessionId('x', sessions)).toBe('b');
  });
  it('falls back to most-recent when there is no override', () => {
    expect(resolveSelectedSessionId(null, sessions)).toBe('b');
  });
  it('keeps a just-created override selected before its row lands in the list (no flip to previous)', () => {
    // The new session id is the override but not yet in the (still refetching) list.
    expect(resolveSelectedSessionId('new', sessions, 'new')).toBe('new');
  });
  it('a pending id only forces selection while it equals the override', () => {
    expect(resolveSelectedSessionId('a', sessions, 'new')).toBe('a');
  });
  it('DRAFT_SENTINEL still passes through even with a pending id', () => {
    expect(resolveSelectedSessionId('__draft__', sessions, 'new')).toBe('__draft__');
  });
});
