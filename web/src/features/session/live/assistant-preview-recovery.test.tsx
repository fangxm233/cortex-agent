import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

interface Handlers {
  onData(raw: unknown): void;
  onError(): void;
  onConnectionStateChange(state: { state: string }): void;
}
const h = vi.hoisted(() => ({
  subs: [] as { sessionId: string; handlers: Handlers; unsubscribe: ReturnType<typeof vi.fn> }[],
  seeds: new Map<string, object>(),
  live: null as null | ((event: any) => void),
  invalidateQueries: vi.fn(),
}));
vi.mock('@/lib/trpc', () => {
  const queryFilter = (input?: unknown) => ({ input });
  const trpc = { sessions: {
    list: { queryFilter }, transcript: { queryFilter },
    subagentTranscript: { queryFilter }, pendingInteraction: { queryFilter },
  }, waitpoints: { list: { queryFilter } } };
  const client = { subscribe: { subscribe: (input: { sessionId: string }, handlers: Handlers) => {
    const sub = { sessionId: input.sessionId, handlers, unsubscribe: vi.fn() };
    h.subs.push(sub);
    // Seed during subscribe: exercises the real hook's effect ordering against session reset.
    const payload = h.seeds.get(input.sessionId);
    if (payload) handlers.onData({ type: 'session.message.delta', payload });
    return sub;
  } } };
  return { useTRPC: () => trpc, useTRPCClient: () => client };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: h.invalidateQueries,
    getQueryCache: () => ({ findAll: () => [] }),
  }),
}));
vi.mock('@/features/live/LiveEventsProvider', () => ({
  useLiveConnection: () => ({ reconnectEpoch: 0 }),
  useLiveEvents: (_types: unknown, handler: (event: any) => void) => { h.live = handler; },
}));
vi.mock('@/features/session/transcript/SubagentTranscriptDetail', () => ({
  activeSubagentTranscriptIds: () => [],
}));

import { useSessionMessageLiveSync, type SessionLiveState } from './useSessionMessageLiveSync';

let state: SessionLiveState;
let mounted: ReactTestRenderer;
function Probe({ sessionId = 'A', enabled = true }) {
  state = useSessionMessageLiveSync(sessionId, true, false, { deltas: enabled });
  return null;
}
function render(sessionId = 'A', enabled = true) {
  act(() => { mounted = create(<Probe sessionId={sessionId} enabled={enabled} />); });
}
function send(payload: object, index = h.subs.length - 1) {
  act(() => h.subs[index].handlers.onData({ type: 'session.message.delta', payload }));
}
function shared(type: string, payload: object) {
  act(() => h.live?.({ type, payload: { sessionId: 'A', ...payload } }));
}
const seed = (text: string, seq = 0, blockId = 'b') => ({ snapshot: true, blockId, text, seq });

beforeEach(() => {
  vi.useFakeTimers();
  h.subs.length = 0;
  h.seeds.clear();
  h.invalidateQueries.mockClear();
});
afterEach(() => {
  act(() => mounted?.unmount());
  vi.useRealTimers();
});

describe('real assistant delta + session live hook lifecycle', () => {
  it('recovers A/B/A, keeps the seed after reset, and ignores the disposed A callback', () => {
    h.seeds.set('A', seed('prefix'));
    h.seeds.set('B', seed('other', 0, 'other-block'));
    render();
    expect(state.streamingText).toBe('prefix');
    act(() => mounted.update(<Probe sessionId="B" />));
    expect(h.subs[0].unsubscribe).toHaveBeenCalledOnce();
    expect(state.streamingText).toBe('other');
    send({ blockId: 'b', text: 'late old A', seq: 1 }, 0);
    expect(state.streamingText).toBe('other');
    h.seeds.set('A', seed('prefix suffix', 1));
    act(() => mounted.update(<Probe sessionId="A" />));
    expect(state.streamingText).toBe('prefix suffix');
    send({ blockId: 'b', text: '!', seq: 2 });
    expect(state.streamingText).toBe('prefix suffix!');
    expect(h.invalidateQueries).not.toHaveBeenCalled();
  });

  it('retries with a replacing snapshot, suppresses duplicates, then converges to one final row', () => {
    h.seeds.set('A', seed('pre'));
    render();
    act(() => h.subs[0].handlers.onError());
    h.seeds.set('A', seed('prefix', 2));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(state.streamingText).toBe('prefix');
    send({ blockId: 'b', text: 'fix', seq: 2 });
    send({ blockId: 'b', text: 'old', seq: 1 });
    send({ blockId: 'b', text: '!', seq: 3 });
    expect(state.streamingText).toBe('prefix!');
    shared('session.message', { role: 'assistant', blockId: 'b', text: 'prefix!' });
    send(seed('prefix!', 3));
    expect(state.streamingText).toBeNull();
    expect(state.liveTail.map((message) => message.text)).toEqual(['prefix!']);
  });

  it('clears a stranded partial on empty reconnect even if the shared final/status was missed', () => {
    h.seeds.set('A', seed('partial'));
    render();
    act(() => h.subs[0].handlers.onError());
    h.seeds.set('A', { snapshot: true, text: '' });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(state.streamingText).toBeNull();
    send(seed('partial', 0));
    expect(state.streamingText).toBeNull();
  });

  it.each(['session.status', 'session.rewound'])('seals previews on %s, without snapshot resurrection', (type) => {
    h.seeds.set('A', seed('partial'));
    render();
    shared(type, { running: false });
    send(seed('partial', 0));
    expect(state.streamingText).toBeNull();
  });

  it('does not clear for notices, child replies, or different-block completion', () => {
    h.seeds.set('A', seed('partial'));
    render();
    for (const fields of [{ noticeLevel: 'info' }, { subagentId: 'child' }, { blockId: 'other' }]) {
      shared('session.message', { role: 'assistant', blockId: 'b', text: 'unrelated', ...fields });
      expect(state.streamingText).toBe('partial');
    }
    shared('session.message', { role: 'assistant', text: 'legacy final' });
    expect(state.streamingText).toBeNull();
  });

  it('ignores disposed callbacks on disable/unmount and does not schedule stale retries', () => {
    render();
    act(() => mounted.update(<Probe enabled={false} />));
    send(seed('late'));
    expect(state.streamingText).toBeNull();
    act(() => {
      h.subs[0].handlers.onError();
      vi.advanceTimersByTime(60_000);
    });
    expect(h.subs).toHaveLength(1);
    act(() => mounted.unmount());
    act(() => h.subs[0].handlers.onError());
    expect(vi.getTimerCount()).toBe(0);
  });
});
