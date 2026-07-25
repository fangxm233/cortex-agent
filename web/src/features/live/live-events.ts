import type { TrpcConnState } from '@/features/connection/connection-status';

// Pure logic for the shared live-event stream (see LiveEventsProvider).
//
// WHY THIS EXISTS: tRPC's httpSubscriptionLink opens ONE EventSource per `subscribe()` call — it does
// not multiplex. The UI used to open one per live surface (chat / rail / threads / tasks / notifications
// / a connectivity probe), which on the workbench meant SIX concurrent SSE connections — exactly the
// per-origin cap a browser allows over plain HTTP/1.1. With the budget spent, every later request
// (attachment thumbnails, uploads, file downloads) queued forever. Over the Cloudflare tunnel the
// browser speaks HTTP/2 and multiplexes, which is why this only bit direct http://host:port access.
//
// The server's `createSubscription` already takes a list of event types and post-filters by
// session/project/execution id, so ONE stream carrying the union of all types is natively supported;
// the fan-out (and the scope filter) then happens here, client-side.

export interface LiveEvent {
  type: string;
  ts?: string;
  /** The raw bus event, as wrapped by the server (`{ type, ts, payload: event }`). */
  payload?: unknown;
}

/** Listener scope. `sessionId` reproduces the server's per-session post-filter client-side. */
export interface LiveScope {
  sessionId?: string;
}

/** Center-chat session lifecycle (workbench chat, rail dots, DM notifications). */
export const SESSION_LIVE_EVENTS = [
  'session.message',
  'session.status',
  'session.turn',
  'session.interaction',
  'session.rewound',
] as const;

/** Thread lifecycle — any of these can change what `threads.list` / `threads.get` returns. */
export const THREAD_LIVE_EVENTS = [
  'thread.created',
  'thread.step.started',
  'thread.step.finished',
  'thread.completed',
  'thread.failed',
] as const;

/** Task lifecycle (Tasks panel). */
export const TASK_LIVE_EVENTS = [
  'task.claimed',
  'task.completed',
  'task.blocked',
  'task.dispatched',
] as const;

/** Server-classified system broadcasts (restart, hot-reload, disk, rate-limit). */
export const SYSTEM_LIVE_EVENTS = ['system.notice'] as const;

/**
 * The FIXED union the shared stream subscribes to. Fixed rather than reference-counted over the
 * mounted listeners: the union is small and known, and a dynamic one would tear down and re-open the
 * SSE every time a live surface mounts/unmounts. It costs nothing in bandwidth either — the app
 * already received every session event unscoped (DM notifications did). Adding a new live event type
 * means adding it to its group above; `live-events.test.ts` asserts every group is contained here.
 */
export const LIVE_EVENT_TYPES: readonly string[] = [
  ...SESSION_LIVE_EVENTS,
  ...THREAD_LIVE_EVENTS,
  ...TASK_LIVE_EVENTS,
  ...SYSTEM_LIVE_EVENTS,
];

/** The event's session id, when it carries one. */
function eventSessionId(ev: LiveEvent): string | null {
  const p = ev.payload;
  if (!p || typeof p !== 'object') return null;
  const sid = (p as { sessionId?: unknown }).sessionId;
  return typeof sid === 'string' && sid ? sid : null;
}

/**
 * Should this listener receive this event? Type must be in the listener's set; a scoped listener
 * additionally drops events belonging to a DIFFERENT session — but an event carrying no sessionId
 * passes, exactly like the server's `if (sessionId && event.sessionId && …)` post-filter
 * (agent-server `domain/ui-service/subscribe.ts`). Keeping that parity is what makes moving a
 * previously server-scoped subscription onto the shared stream behaviour-preserving.
 */
export function matchesLiveEvent(
  ev: LiveEvent,
  types: readonly string[],
  scope?: LiveScope,
): boolean {
  if (!types.includes(ev.type)) return false;
  const want = scope?.sessionId;
  if (!want) return true;
  const got = eventSessionId(ev);
  return got === null || got === want;
}

/** A registered listener: which event types it wants, an optional scope, and its callback. */
export interface LiveListener {
  types: readonly string[];
  scope?: LiveScope;
  fn: (ev: LiveEvent) => void;
}

/**
 * Fan one event out to the matching listeners. Returns how many received it. A listener that throws
 * is contained: one broken surface must not tear down the stream every other surface depends on
 * (with per-hook subscriptions a throw only killed that hook's own connection; now it would take
 * everything down). Callers pass a SNAPSHOT of the listener set — a handler may register or
 * unregister listeners while this runs.
 */
export function dispatchLiveEvent(listeners: readonly LiveListener[], ev: LiveEvent): number {
  let delivered = 0;
  for (const l of listeners) {
    if (!matchesLiveEvent(ev, l.types, l.scope)) continue;
    delivered++;
    try {
      l.fn(ev);
    } catch {
      // Contained on purpose — see above.
    }
  }
  return delivered;
}

/** Connection-state accumulator: the has-ever-connected latch + the reconnect counter. */
export interface ConnAccum {
  hasConnected: boolean;
  /** Bumped each time the stream re-enters `pending` AFTER a drop — i.e. a real reconnect.
   *  Consumers that lost events while the stream was down refetch when this changes. */
  epoch: number;
  /** Internal: the stream left `pending` after having connected, so the next connect is a RE-connect. */
  down: boolean;
}

export function initialConnAccum(): ConnAccum {
  return { hasConnected: false, epoch: 0, down: false };
}

/**
 * Fold one tRPC connection state into the accumulator. Replaces the per-hook `wasConnected` flag
 * every live-sync hook used to keep (they each refetched on re-entering `pending`): with one shared
 * stream there is one latch and one epoch, so a drop triggers exactly one coordinated refetch round.
 */
export function applyConnState(prev: ConnAccum, state: TrpcConnState): ConnAccum {
  if (state !== 'pending') {
    // Only a departure from an established connection counts as a drop.
    return prev.hasConnected && !prev.down ? { ...prev, down: true } : prev;
  }
  if (!prev.hasConnected) return { hasConnected: true, epoch: prev.epoch, down: false };
  if (prev.down) return { hasConnected: true, epoch: prev.epoch + 1, down: false };
  return prev;
}
