// input:  Vitest and shared live-event pure rules
// output: shared-union, compact/context refresh, scope/reconnect tests
// pos:    Unit tests for the Web shared SSE event model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  applyConnState,
  dispatchLiveEvent,
  initialConnAccum,
  isProfileConfigChanged,
  matchesLiveEvent,
  ASSISTANT_DELTA_EVENTS,
  CONFIG_LIVE_EVENTS,
  RATE_LIMIT_LIVE_EVENTS,
  LIVE_EVENT_TYPES,
  SESSION_LIVE_EVENTS,
  SYSTEM_LIVE_EVENTS,
  TASK_LIVE_EVENTS,
  THREAD_LIVE_EVENTS,
  type LiveEvent,
} from './live-events';

const ev = (type: string, payload?: Record<string, unknown>): LiveEvent => ({ type, payload });

describe('LIVE_EVENT_TYPES', () => {
  it('is the union of every consumer group — a group event missing here would never reach its hook', () => {
    for (const t of [...SESSION_LIVE_EVENTS, ...THREAD_LIVE_EVENTS, ...TASK_LIVE_EVENTS, ...SYSTEM_LIVE_EVENTS, ...CONFIG_LIVE_EVENTS, ...RATE_LIMIT_LIVE_EVENTS]) {
      expect(LIVE_EVENT_TYPES).toContain(t);
    }
  });
  it('carries no duplicates (one bus subscription per type on the server)', () => {
    expect(new Set(LIVE_EVENT_TYPES).size).toBe(LIVE_EVENT_TYPES.length);
  });
});

describe('SESSION_LIVE_EVENTS', () => {
  it('carries the mid-turn delivery commit — without it a sent message stays dimmed forever', () => {
    expect(SESSION_LIVE_EVENTS).toContain('session.message.delivered');
  });
  it('carries context usage/compaction plus the content-free DEBUG refresh hint', () => {
    expect(SESSION_LIVE_EVENTS).toContain('session.context-usage');
    expect(LIVE_EVENT_TYPES).toContain('session.context-usage');
    expect(SESSION_LIVE_EVENTS).toContain('session.context-compacted');
    expect(LIVE_EVENT_TYPES).toContain('session.context-compacted');
    expect(SESSION_LIVE_EVENTS).toContain('session.debug.updated');
    expect(LIVE_EVENT_TYPES).toContain('session.debug.updated');
  });
});

describe('RATE_LIMIT_LIVE_EVENTS', () => {
  it('carries the content-free throttle refresh hint on the shared stream', () => {
    expect(RATE_LIMIT_LIVE_EVENTS).toEqual(['rate-limit.changed']);
    expect(LIVE_EVENT_TYPES).toContain('rate-limit.changed');
  });
});

describe('CONFIG_LIVE_EVENTS', () => {
  it('carries the structured config change hint on the shared stream', () => {
    expect(CONFIG_LIVE_EVENTS).toEqual(['config.changed']);
    expect(LIVE_EVENT_TYPES).toContain('config.changed');
  });

  it('recognizes only a profiles config change as a profile refresh hint', () => {
    expect(isProfileConfigChanged(ev('config.changed', { section: 'profiles' }))).toBe(true);
    expect(isProfileConfigChanged(ev('config.changed', { section: 'budget' }))).toBe(false);
    expect(isProfileConfigChanged(ev('system.notice', { section: 'profiles' }))).toBe(false);
    expect(isProfileConfigChanged(ev('config.changed'))).toBe(false);
  });
});

describe('ASSISTANT_DELTA_EVENTS', () => {
  it('names the token-level preview event', () => {
    expect(ASSISTANT_DELTA_EVENTS).toEqual(['session.message.delta']);
  });
  it('is deliberately OUTSIDE the shared union — the server only serves it session-scoped', () => {
    for (const t of ASSISTANT_DELTA_EVENTS) expect(LIVE_EVENT_TYPES).not.toContain(t);
  });
});

describe('matchesLiveEvent — type filter', () => {
  it('passes an event whose type is in the listener set', () => {
    expect(matchesLiveEvent(ev('session.status'), ['session.status', 'session.message'])).toBe(true);
  });
  it('rejects an event outside the listener set', () => {
    expect(matchesLiveEvent(ev('task.claimed'), THREAD_LIVE_EVENTS)).toBe(false);
  });
  it('rejects the synthetic overflow event unless explicitly listened for', () => {
    expect(matchesLiveEvent(ev('ui-subscribe.dropped'), SESSION_LIVE_EVENTS)).toBe(false);
  });
});

describe('matchesLiveEvent — sessionId scope (mirrors the server post-filter)', () => {
  const types = SESSION_LIVE_EVENTS;
  it('passes an event for the scoped session', () => {
    expect(matchesLiveEvent(ev('session.message', { sessionId: 's1' }), types, { sessionId: 's1' })).toBe(true);
  });
  it('drops an event belonging to another session', () => {
    expect(matchesLiveEvent(ev('session.message', { sessionId: 's2' }), types, { sessionId: 's1' })).toBe(false);
  });
  it('passes an event carrying NO sessionId — server parity (`event.sessionId &&` guard)', () => {
    expect(matchesLiveEvent(ev('session.status', { running: true }), types, { sessionId: 's1' })).toBe(true);
  });
  it('ignores the scope entirely when the listener is unscoped', () => {
    expect(matchesLiveEvent(ev('session.message', { sessionId: 's2' }), types)).toBe(true);
    expect(matchesLiveEvent(ev('session.message', { sessionId: 's2' }), types, {})).toBe(true);
  });
  it('tolerates a missing / non-object payload', () => {
    expect(matchesLiveEvent({ type: 'session.status' }, types, { sessionId: 's1' })).toBe(true);
    expect(matchesLiveEvent({ type: 'session.status', payload: 'nope' }, types, { sessionId: 's1' })).toBe(true);
  });
});

describe('dispatchLiveEvent — fan-out', () => {
  it('delivers only to listeners whose type set and scope match', () => {
    const seen: string[] = [];
    const listeners = [
      { types: SESSION_LIVE_EVENTS, fn: () => seen.push('chat-any') },
      { types: SESSION_LIVE_EVENTS, scope: { sessionId: 's1' }, fn: () => seen.push('chat-s1') },
      { types: SESSION_LIVE_EVENTS, scope: { sessionId: 's2' }, fn: () => seen.push('chat-s2') },
      { types: THREAD_LIVE_EVENTS, fn: () => seen.push('threads') },
    ];
    const delivered = dispatchLiveEvent(listeners, ev('session.message', { sessionId: 's1' }));
    expect(seen).toEqual(['chat-any', 'chat-s1']);
    expect(delivered).toBe(2);
  });
  it('a throwing listener does not stop the others (the stream must survive one bad surface)', () => {
    const seen: string[] = [];
    const listeners = [
      { types: TASK_LIVE_EVENTS, fn: () => { throw new Error('boom'); } },
      { types: TASK_LIVE_EVENTS, fn: () => seen.push('second') },
    ];
    expect(() => dispatchLiveEvent(listeners, ev('task.claimed'))).not.toThrow();
    expect(seen).toEqual(['second']);
  });
  it('delivers nothing when no listener matches', () => {
    expect(dispatchLiveEvent([{ types: TASK_LIVE_EVENTS, fn: () => {} }], ev('system.notice'))).toBe(0);
  });
});

describe('applyConnState — shared reconnect epoch', () => {
  it('first connect latches hasConnected without counting a reconnect', () => {
    const a = applyConnState(initialConnAccum(), 'connecting');
    expect(a).toMatchObject({ hasConnected: false, epoch: 0 });
    const b = applyConnState(a, 'pending');
    expect(b).toMatchObject({ hasConnected: true, epoch: 0 });
  });
  it('re-entering pending after a drop bumps the epoch (the refetch trigger)', () => {
    let s = applyConnState(applyConnState(initialConnAccum(), 'connecting'), 'pending');
    s = applyConnState(s, 'connecting');
    expect(s.epoch).toBe(0);
    s = applyConnState(s, 'pending');
    expect(s).toMatchObject({ hasConnected: true, epoch: 1 });
  });
  it('repeated pending states without an intervening drop do not bump the epoch', () => {
    let s = applyConnState(initialConnAccum(), 'pending');
    s = applyConnState(s, 'pending');
    expect(s.epoch).toBe(0);
  });
  it('idle after connecting keeps the latch (a drop, not a fresh start)', () => {
    let s = applyConnState(initialConnAccum(), 'pending');
    s = applyConnState(s, 'idle');
    expect(s.hasConnected).toBe(true);
    expect(s.epoch).toBe(0);
    s = applyConnState(s, 'pending');
    expect(s.epoch).toBe(1);
  });
});
