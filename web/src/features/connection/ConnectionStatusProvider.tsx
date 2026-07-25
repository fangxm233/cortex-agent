import { createContext, useContext, type ReactNode } from 'react';
import { useLiveConnection } from '@/features/live/LiveEventsProvider';
import { deriveConnectionStatus, type ConnectionStatus } from './connection-status';

// Global source of truth for "is the UI talking to the agent-server". Derived from the SHARED live
// stream's link state (`features/live/LiveEventsProvider`), which transitions connecting → pending →
// connecting as the SSE goes up and down.
//
// This used to open its OWN subscription with an EMPTY event set, purely to observe
// `onConnectionStateChange` — an entire HTTP connection spent on a heartbeat. With the app down to a
// single shared stream that probe is redundant: the stream everyone else already listens on reports
// the same transitions, and its `hasConnected` latch (pure `applyConnState`) distinguishes the first
// approach from a post-drop retry exactly as the old local ref did.
//
// Mounted once per shell (`shell/AppShell` desktop · `mobile/MobileShell` mobile) INSIDE
// LiveEventsProvider, so both surfaces read the live status via `useConnectionStatus()`.

const ConnectionStatusContext = createContext<ConnectionStatus>('connecting');

export function ConnectionStatusProvider({ children }: { children: ReactNode }) {
  const { connState, hasConnected } = useLiveConnection();
  const status = deriveConnectionStatus(connState, hasConnected);

  return (
    <ConnectionStatusContext.Provider value={status}>
      {children}
    </ConnectionStatusContext.Provider>
  );
}

/** Live connectivity between the UI and the agent-server. Defaults to `connecting` before the
 *  shared stream's first state change (accurate — the link has not connected yet). */
export function useConnectionStatus(): ConnectionStatus {
  return useContext(ConnectionStatusContext);
}
