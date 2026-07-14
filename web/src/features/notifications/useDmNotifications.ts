import { useEffect } from 'react';
import { useTRPCClient } from '@/lib/trpc';

// Thin SSE glue: one global `session.message` subscription (no sessionId scope → all sessions).
// A "DM message" is an assistant message Cortex posts in a direct chat session; the caller gates
// the raw events to direct sessions and builds the toast (NotificationProvider). Mirrors
// features/workbench/useThreadsLiveSync / useSessionMessageLiveSync — all shaping lives outside.

/** The assistant `session.message` payload we surface as a DM notification. */
export interface DmAssistantMessage {
  sessionId: string;
  channel: string | null;
  text: string;
  ts: string | null;
}

/**
 * Subscribe to assistant `session.message` events app-wide and hand each to `onMessage`.
 * User/tool messages and empty assistant texts are filtered out here (only Cortex's DM replies
 * flow through). Closes the subscription on unmount. `onMessage` should be stable (useCallback).
 */
export function useDmNotifications(onMessage: (msg: DmAssistantMessage) => void): void {
  const client = useTRPCClient();

  useEffect(() => {
    const sub = client.subscribe.subscribe(
      { events: ['session.message'] },
      {
        onData: (raw: { type?: string; payload?: unknown }) => {
          if (raw?.type !== 'session.message') return;
          const p = raw.payload as
            | { sessionId?: string; channel?: string; role?: string; text?: string; ts?: string }
            | undefined;
          if (!p || p.role !== 'assistant') return;
          const text = (p.text ?? '').trim();
          if (!text || !p.sessionId) return;
          onMessage({
            sessionId: p.sessionId,
            channel: p.channel ?? null,
            text,
            ts: p.ts ?? null,
          });
        },
      },
    );
    return () => sub.unsubscribe();
  }, [client, onMessage]);
}
