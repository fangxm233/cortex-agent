// input:  a fake tRPC client whose subscribe() handlers the test drives by hand
// output: recovery tests for the shared live stream (terminal error → backoff re-subscribe)
// pos:    Regression cover for the "badge stuck on connecting, page otherwise fine" failure — a
//         single 401/302/502 on /trpc/subscribe used to kill live events for the life of the page.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SubHandlers {
  onConnectionStateChange: (s: { state: string }) => void;
  onData: (raw: unknown) => void;
  onError: (err?: unknown) => void;
}

const h = vi.hoisted(() => ({
  subs: [] as { handlers: SubHandlers; unsubscribed: boolean }[],
  invalidate: vi.fn(),
}));

// STABLE identities, like the real hooks: the subscription effect keys on them, so a fresh object
// per render would re-subscribe on every state change and hide what these tests measure.
vi.mock('@/lib/trpc', () => {
  const client = {
    subscribe: {
      subscribe: (_input: unknown, handlers: SubHandlers) => {
        const entry = { handlers, unsubscribed: false };
        h.subs.push(entry);
        return {
          unsubscribe: () => {
            entry.unsubscribed = true;
          },
        };
      },
    },
  };
  const trpc = { config: { get: { queryFilter: () => ({ queryKey: ['config'] }) } } };
  return { useTRPCClient: () => client, useTRPC: () => trpc };
});
vi.mock('@tanstack/react-query', () => {
  const queryClient = { invalidateQueries: h.invalidate };
  return { useQueryClient: () => queryClient };
});

import { LiveEventsProvider, useLiveConnection } from './LiveEventsProvider';

let seen: ReturnType<typeof useLiveConnection> = { connState: 'idle', hasConnected: false, reconnectEpoch: 0 };

function Probe(): null {
  seen = useLiveConnection();
  return null;
}

const last = (): SubHandlers => h.subs[h.subs.length - 1].handlers;
const render = (): ReactTestRenderer => {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <LiveEventsProvider>
        <Probe />
      </LiveEventsProvider>,
    );
  });
  return r;
};

// The web suite runs in Node (no jsdom), but the provider's wake path is DOM-shaped. An EventTarget
// pair is everything it touches — addEventListener / removeEventListener / visibilityState — so the
// listeners register for real and the tests can dispatch to them.
const install = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
const uninstall = (name: string): void => {
  Reflect.deleteProperty(globalThis, name);
};

beforeEach(() => {
  h.subs.length = 0;
  h.invalidate.mockClear();
  install('window', new EventTarget());
  install('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  uninstall('window');
  uninstall('document');
});

describe('LiveEventsProvider — recovery from a terminal stream error', () => {
  it('re-subscribes after the backoff instead of staying dead for the life of the page', () => {
    const r = render();
    expect(h.subs).toHaveLength(1);

    act(() => last().onError(new Error('401')));
    expect(seen.connState).toBe('idle');
    expect(h.subs).toHaveLength(1); // not instantly — the retry waits out the backoff

    act(() => void vi.advanceTimersByTime(999));
    expect(h.subs).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(h.subs).toHaveLength(2);
    expect(h.subs[0].unsubscribed).toBe(true);

    act(() => last().onConnectionStateChange({ state: 'pending' }));
    expect(seen.connState).toBe('pending');
    expect(seen.hasConnected).toBe(true);
    act(() => r.unmount());
  });

  it('doubles the delay while attempts keep failing, and starts over after a successful connect', () => {
    const r = render();

    act(() => last().onError());
    act(() => void vi.advanceTimersByTime(1_000));
    expect(h.subs).toHaveLength(2);

    // Second consecutive failure: 2s, not 1s.
    act(() => last().onError());
    act(() => void vi.advanceTimersByTime(1_999));
    expect(h.subs).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(1));
    expect(h.subs).toHaveLength(3);

    // A handshake resets the ladder, so the next outage is fast again.
    act(() => last().onConnectionStateChange({ state: 'pending' }));
    act(() => last().onError());
    act(() => void vi.advanceTimersByTime(1_000));
    expect(h.subs).toHaveLength(4);
    act(() => r.unmount());
  });

  it('counts the recovered stream as a reconnect so consumers refetch what they missed', () => {
    const r = render();
    act(() => last().onConnectionStateChange({ state: 'pending' }));
    expect(seen.reconnectEpoch).toBe(0);

    act(() => last().onError());
    act(() => void vi.advanceTimersByTime(1_000));
    act(() => last().onConnectionStateChange({ state: 'pending' }));
    expect(seen.reconnectEpoch).toBe(1);
    act(() => r.unmount());
  });

  it('drops the pending retry on unmount — a torn-down provider must not resurrect a stream', () => {
    const r = render();
    act(() => last().onError());
    act(() => r.unmount());
    act(() => void vi.advanceTimersByTime(60_000));
    expect(h.subs).toHaveLength(1);
    expect(h.subs[0].unsubscribed).toBe(true);
  });

  it('retries at once when the tab comes back to the foreground, instead of waiting out the backoff', () => {
    const r = render();
    act(() => last().onError());
    act(() => void vi.advanceTimersByTime(1_000)); // #2
    act(() => last().onError()); // next scheduled retry would be 2s away
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(h.subs).toHaveLength(3);

    // ...and the timer it replaced does not fire a second, redundant subscription.
    act(() => void vi.advanceTimersByTime(60_000));
    expect(h.subs).toHaveLength(3);
    act(() => r.unmount());
  });

  it('ignores a wake while the stream is healthy', () => {
    const r = render();
    act(() => last().onConnectionStateChange({ state: 'pending' }));
    act(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(h.subs).toHaveLength(1);
    act(() => r.unmount());
  });
});
