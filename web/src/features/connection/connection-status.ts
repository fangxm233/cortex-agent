// Pure connection-status view-model. Maps the tRPC subscription connection state
// (`idle` | `connecting` | `pending`, from @trpc/client's `onConnectionStateChange`) into the
// user-facing status the LeftRail daemon badge renders.
//
// tRPC state machine (httpSubscriptionLink): the link starts in `connecting`; flips to `pending`
// once the SSE opens (the transport's `connected` handshake); drops back to `connecting` while the
// EventSource auto-reconnects after a network blip; and settles to `idle` only once the stream is
// closed/stopped. A `hasConnected` latch (owned by the caller) distinguishes the very first approach
// (`connecting`) from a post-drop retry (`reconnecting`) so the badge never reads "reconnecting"
// before it has ever connected, nor a scary "disconnected" on first paint.

export type TrpcConnState = 'idle' | 'connecting' | 'pending';
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** Map the raw tRPC connection state + the has-ever-connected latch to a display status. */
export function deriveConnectionStatus(
  state: TrpcConnState,
  hasConnected: boolean,
): ConnectionStatus {
  if (state === 'pending') return 'connected';
  if (state === 'connecting') return hasConnected ? 'reconnecting' : 'connecting';
  // `idle` — the stream stopped. After a successful connection this means the link is down; before
  // we ever connected it is still the initial approach, so don't alarm.
  return hasConnected ? 'disconnected' : 'connecting';
}

export interface ConnectionDot {
  /** CSS variable driving the dot + label color (light/dark themed). */
  color: string;
  /** Whether the dot pulses — true while the link is (re)connecting. */
  pulse: boolean;
}

/** Presentational tokens for the badge dot/label per status (theme CSS vars, no raw hex). */
export function connectionDot(status: ConnectionStatus): ConnectionDot {
  switch (status) {
    case 'connected':
      return { color: 'var(--proto-success)', pulse: false };
    case 'connecting':
    case 'reconnecting':
      return { color: 'var(--proto-amber)', pulse: true };
    case 'disconnected':
      return { color: 'var(--proto-danger)', pulse: false };
  }
}

export type ConnectionLabelKey =
  | 'connConnected'
  | 'connConnecting'
  | 'connReconnecting'
  | 'connDisconnected';

/** The vocab key for the status label — resolved by the caller against the active language. */
export function connectionLabelKey(status: ConnectionStatus): ConnectionLabelKey {
  switch (status) {
    case 'connected':
      return 'connConnected';
    case 'connecting':
      return 'connConnecting';
    case 'reconnecting':
      return 'connReconnecting';
    case 'disconnected':
      return 'connDisconnected';
  }
}
