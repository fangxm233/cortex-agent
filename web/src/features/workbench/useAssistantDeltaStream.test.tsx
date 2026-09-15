// input:  a fake tRPC client whose subscribe() handlers the test drives by hand
// output: tests for the per-session delta stream: scope, fan-in, and recovery after a terminal error
// pos:    Regression cover for "replies stopped streaming until I clicked away and back"

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantDeltaEvent } from './transcript-vm';

interface SubHandlers {
  onConnectionStateChange?: (s: { state: string }) => void;
  onData: (raw: unknown) => void;
  onError: (err?: unknown) => void;
}

const h = vi.hoisted(() => ({
  subs: [] as { input: { sessionId?: string }; handlers: SubHandlers; unsubscribed: boolean }[],
}));

vi.mock('@/lib/trpc', () => {
  const client = {
    subscribe: {
      subscribe: (input: { sessionId?: string }, handlers: SubHandlers) => {
        const entry = { input, handlers, unsubscribed: false };
        h.subs.push(entry);
        return {
          unsubscribe: () => {
            entry.unsubscribed = true;
          },
        };
      },
    },
  };
  return { useTRPCClient: () => client };
});

import { useAssistantDeltaStream } from './useAssistantDeltaStream';

const deltas: AssistantDeltaEvent[] = [];

function Harness({ sessionId, enabled }: { sessionId: string; enabled: boolean }): null {
  useAssistantDeltaStream(sessionId, enabled, (ev) => deltas.push(ev));
  return null;
}

const last = (): SubHandlers => h.subs[h.subs.length - 1].handlers;
const render = (sessionId = 's1', enabled = true): ReactTestRenderer => {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<Harness sessionId={sessionId} enabled={enabled} />);
  });
  return r;
};

beforeEach(() => {
  h.subs.length = 0;
  deltas.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useAssistantDeltaStream', () => {
  it('opens one session-scoped stream and forwards only delta payloads', () => {
    const r = render();
    expect(h.subs).toHaveLength(1);
    expect(h.subs[0].input.sessionId).toBe('s1');

    act(() => last().onData({ type: 'session.message.delta', payload: { text: 'hi' } }));
    act(() => last().onData({ type: 'session.status', payload: { text: 'no' } }));
    act(() => last().onData(undefined));
    expect(deltas).toEqual([{ text: 'hi' }]);
    act(() => r.unmount());
  });

  it('re-opens after a terminal error instead of leaving the chat without previews', () => {
    const r = render();
    act(() => last().onError());
    expect(h.subs).toHaveLength(1);

    act(() => void vi.advanceTimersByTime(1_000));
    expect(h.subs).toHaveLength(2);
    expect(h.subs[1].input.sessionId).toBe('s1');
    expect(h.subs[0].unsubscribed).toBe(true);

    // Still failing → the wait doubles; a handshake resets it.
    act(() => last().onError());
    act(() => void vi.advanceTimersByTime(1_999));
    expect(h.subs).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(1));
    expect(h.subs).toHaveLength(3);

    act(() => last().onConnectionStateChange?.({ state: 'pending' }));
    act(() => last().onError());
    act(() => void vi.advanceTimersByTime(1_000));
    expect(h.subs).toHaveLength(4);
    act(() => r.unmount());
  });

  it('abandons a pending retry when the surface goes away', () => {
    const r = render();
    act(() => last().onError());
    act(() => r.unmount());
    act(() => void vi.advanceTimersByTime(60_000));
    expect(h.subs).toHaveLength(1);
    expect(h.subs[0].unsubscribed).toBe(true);
  });

  it('opens nothing while disabled or session-less', () => {
    const a = render('s1', false);
    const b = render('', true);
    expect(h.subs).toHaveLength(0);
    act(() => {
      a.unmount();
      b.unmount();
    });
  });
});
