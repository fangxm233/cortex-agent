import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import type { TrpcConnState } from '@/features/connection/connection-status';
import {
  applyConnState,
  dispatchLiveEvent,
  initialConnAccum,
  isConfigSnapshotChanged,
  LIVE_EVENT_TYPES,
  liveRetryDelayMs,
  type ConnAccum,
  type LiveEvent,
  type LiveListener,
  type LiveScope,
} from './live-events';

// SHARED LIVE-EVENT STREAM — one SSE subscription for the whole app, fanned out client-side.
//
// Before this, every live surface opened its own `client.subscribe.subscribe(...)`: the chat, the
// rail's running dots, the threads panel, each expanded thread card, the tasks panel, DM notifications,
// system notices, plus a connectivity probe that subscribed to an EMPTY event set just to watch the
// link state. tRPC's httpSubscriptionLink does not multiplex, so that was 6+ concurrent EventSources —
// the exact per-origin connection cap of HTTP/1.1, after which every other request (thumbnails,
// uploads, downloads) queued forever on a direct plain-HTTP origin.
//
// Now: ONE subscription carrying the fixed union of event types (`LIVE_EVENT_TYPES`), with listeners
// registered through `useLiveEvents(types, handler, scope?)`. The connection state of that one stream
// is published too, so the daemon badge needs no probe of its own and every consumer shares a single
// reconnect signal (`reconnectEpoch`) instead of each tracking its own.
//
// NOT merged: the execution log drawer. It holds no subscription at all — there is no execution.*
// lifecycle event, so it polls `executions.get` while the run is running and stops when it ends.
//
// Owning the only stream also means owning its recovery: a terminal error on the subscribe request
// ends the tRPC observable for good, so this provider re-opens it on a backoff (`liveRetryDelayMs`)
// and immediately on an `online` / tab-visible wake. Nothing else in the app can bring it back.

interface LiveEventsContextValue {
  /** Register a listener; returns the unregister callback. */
  register: (l: LiveListener) => () => void;
  /** Raw link state of the shared stream (feeds the connectivity badge). */
  connState: TrpcConnState;
  /** Has the stream ever connected? The latch behind "connecting" vs "reconnecting". */
  hasConnected: boolean;
  /** Incremented on every reconnect after a drop — consumers refetch what they missed. */
  reconnectEpoch: number;
}

// No provider in scope (isolated component tests) → registering is inert and the stream reads as
// never-connected, which is honest: there is no stream.
const LiveEventsContext = createContext<LiveEventsContextValue>({
  register: () => () => {},
  connState: 'connecting',
  hasConnected: false,
  reconnectEpoch: 0,
});

export function LiveEventsProvider({ children }: { children: ReactNode }): JSX.Element {
  const client = useTRPCClient();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [configQueryFilter] = useState(() => trpc.config.get.queryFilter({}));
  const listenersRef = useRef<Set<LiveListener>>(new Set());
  const [conn, setConn] = useState<{ state: TrpcConnState; accum: ConnAccum }>(() => ({
    state: 'connecting',
    accum: initialConnAccum(),
  }));
  // Bumping this generation re-runs the effect below: the dead subscription is disposed and a fresh
  // one opened. It is the ONLY way back from a terminal transport error — tRPC ends the observable
  // and nothing about a query's success would ever revive it.
  const [generation, setGeneration] = useState(0);
  // Consecutive failed attempts (backoff step), the pending retry timer, and whether the stream is
  // currently believed dead. Refs, not state: none of them belong in a render.
  const failuresRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadRef = useRef(false);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current === null) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    const sub = client.subscribe.subscribe(
      { events: [...LIVE_EVENT_TYPES] },
      {
        onConnectionStateChange: (s: { state: string }) => {
          const state = s.state as TrpcConnState;
          // A completed handshake is the only proof the stream is alive again: reset the backoff so
          // the NEXT outage starts at 1s rather than wherever the last one ended.
          if (state === 'pending') {
            failuresRef.current = 0;
            deadRef.current = false;
          }
          setConn((prev) => ({ state, accum: applyConnState(prev.accum, state) }));
        },
        onData: (raw: unknown) => {
          const ev = raw as LiveEvent;
          if (!ev || typeof ev.type !== 'string') return;
          if (isConfigSnapshotChanged(ev)) {
            void queryClient.invalidateQueries(configQueryFilter);
          }
          // Snapshot: a handler may register/unregister listeners while we fan out.
          dispatchLiveEvent([...listenersRef.current], ev);
        },
        // A terminal (non-retryable) error tears the stream down without an `idle` state change —
        // report it as a dropped link, then re-open on a backoff. Before this retry existed a single
        // 401/302/502 on the subscribe request (session expiry, SSO bounce, a server restart) left
        // the page live-event-deaf until a manual reload, while every query kept working — the badge
        // sat on "connecting" forever because the stream had never reached `pending`.
        onError: () => {
          setConn((prev) => ({ state: 'idle', accum: applyConnState(prev.accum, 'idle') }));
          deadRef.current = true;
          if (disposed || retryTimerRef.current !== null) return;
          const delay = liveRetryDelayMs(failuresRef.current++);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            setGeneration((n) => n + 1);
          }, delay);
        },
      },
    );
    return () => {
      disposed = true;
      clearRetry();
      sub.unsubscribe();
    };
  }, [client, configQueryFilter, queryClient, generation, clearRetry]);

  // Wake triggers: coming back online, or returning to a tab that was backgrounded (laptop asleep,
  // phone locked) is exactly when a dead stream should be retried NOW instead of at the end of a
  // 30s backoff. Only acts on a stream known to be dead, so a healthy one is never disturbed.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const wake = (): void => {
      if (!deadRef.current) return;
      if (document.visibilityState === 'hidden') return;
      clearRetry();
      failuresRef.current = 0; // a wake is a new situation, not the next failed attempt
      setGeneration((n) => n + 1);
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [clearRetry]);

  // Stable across connection-state changes — otherwise every listener would re-register on each
  // connect/drop (harmless but pointless churn, and it would re-run consumers' effects).
  const register = useCallback((l: LiveListener) => {
    listenersRef.current.add(l);
    return () => {
      listenersRef.current.delete(l);
    };
  }, []);

  const value = useMemo<LiveEventsContextValue>(
    () => ({
      register,
      connState: conn.state,
      hasConnected: conn.accum.hasConnected,
      reconnectEpoch: conn.accum.epoch,
    }),
    [register, conn],
  );

  return <LiveEventsContext.Provider value={value}>{children}</LiveEventsContext.Provider>;
}

/**
 * Receive the shared stream's events for `types` (optionally scoped to one session). The handler is
 * read through a ref, so it does NOT need to be stable — a re-render never re-registers, and the
 * underlying SSE connection is never touched.
 */
export function useLiveEvents(
  types: readonly string[],
  handler: (ev: LiveEvent) => void,
  scope?: LiveScope,
): void {
  const { register } = useContext(LiveEventsContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  // Primitive deps: re-register only when the listened types or the scope actually change.
  const typeKey = types.join(',');
  const sessionId = scope?.sessionId;

  useEffect(() => {
    return register({
      types: typeKey.split(','),
      scope: sessionId ? { sessionId } : undefined,
      fn: (ev) => handlerRef.current(ev),
    });
  }, [register, typeKey, sessionId]);
}

/** The shared stream's link state + reconnect counter (connectivity badge, refetch-on-reconnect). */
export function useLiveConnection(): {
  connState: TrpcConnState;
  hasConnected: boolean;
  reconnectEpoch: number;
} {
  const { connState, hasConnected, reconnectEpoch } = useContext(LiveEventsContext);
  return { connState, hasConnected, reconnectEpoch };
}
