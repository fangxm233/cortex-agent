import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTRPCClient } from '@/lib/trpc';
import {
  deriveConnectionStatus,
  type ConnectionStatus,
  type TrpcConnState,
} from './connection-status';

// Global source of truth for "is the UI talking to the agent-server". A single, always-on SSE
// subscription whose ONLY job is to observe the tRPC link's connection state
// (`onConnectionStateChange`). It subscribes to an EMPTY event set so it never does feature work —
// the tRPC transport keeps the stream alive with pings and reports connect / drop / reconnect, which
// is exactly the signal the LeftRail daemon badge needs. Feature subscriptions (sessions/threads/
// chat) each handle their own reconnect recovery; this provider only surfaces connectivity.
//
// Mounted once in `providers.tsx` (inside TRPCProvider) so both the desktop workbench and the mobile
// shell can read the live status via `useConnectionStatus()`.

const ConnectionStatusContext = createContext<ConnectionStatus>('connecting');

export function ConnectionStatusProvider({ children }: { children: ReactNode }) {
  const client = useTRPCClient();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // Latch: once we have ever reached `pending`, a later `connecting` reads as "reconnecting" and an
  // `idle` reads as "disconnected"; before that both read as the initial "connecting".
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    const apply = (state: TrpcConnState) => {
      if (state === 'pending') hasConnectedRef.current = true;
      setStatus(deriveConnectionStatus(state, hasConnectedRef.current));
    };

    const sub = client.subscribe.subscribe(
      { events: [] },
      {
        // Primary signal — the tRPC link transitions through connecting → pending → connecting
        // (auto-reconnect) as the SSE goes up and down.
        onConnectionStateChange: (s: { state: string }) => apply(s.state as TrpcConnState),
        // No feature data flows on an empty event set; ignore.
        onData: () => {},
        // A terminal (non-retryable) error tears the stream down without an `idle` state change —
        // treat it as a dropped link.
        onError: () => apply('idle'),
      },
    );
    return () => sub.unsubscribe();
  }, [client]);

  return (
    <ConnectionStatusContext.Provider value={status}>
      {children}
    </ConnectionStatusContext.Provider>
  );
}

/** Live connectivity between the UI and the agent-server. Defaults to `connecting` before the
 *  provider's first state change (accurate — the link has not connected yet). */
export function useConnectionStatus(): ConnectionStatus {
  return useContext(ConnectionStatusContext);
}
