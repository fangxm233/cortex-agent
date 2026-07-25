import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTRPCClient } from '@/lib/trpc';
import type { TrpcConnState } from '@/features/connection/connection-status';
import {
  applyConnState,
  dispatchLiveEvent,
  initialConnAccum,
  LIVE_EVENT_TYPES,
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
// NOT merged: `executions.log` (a different procedure, executionId-scoped, high-volume, and only open
// while the log drawer is).

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
  const listenersRef = useRef<Set<LiveListener>>(new Set());
  const [conn, setConn] = useState<{ state: TrpcConnState; accum: ConnAccum }>(() => ({
    state: 'connecting',
    accum: initialConnAccum(),
  }));

  useEffect(() => {
    const sub = client.subscribe.subscribe(
      { events: [...LIVE_EVENT_TYPES] },
      {
        onConnectionStateChange: (s: { state: string }) => {
          const state = s.state as TrpcConnState;
          setConn((prev) => ({ state, accum: applyConnState(prev.accum, state) }));
        },
        onData: (raw: unknown) => {
          const ev = raw as LiveEvent;
          if (!ev || typeof ev.type !== 'string') return;
          // Snapshot: a handler may register/unregister listeners while we fan out.
          dispatchLiveEvent([...listenersRef.current], ev);
        },
        // A terminal (non-retryable) error tears the stream down without an `idle` state change —
        // report it as a dropped link (the old connectivity probe did the same).
        onError: () => {
          setConn((prev) => ({ state: 'idle', accum: applyConnState(prev.accum, 'idle') }));
        },
      },
    );
    return () => sub.unsubscribe();
  }, [client]);

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
