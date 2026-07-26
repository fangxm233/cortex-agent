import { useEffect, useRef } from 'react';
import { useTRPCClient } from '@/lib/trpc';
import { ASSISTANT_DELTA_EVENTS } from '@/features/live/live-events';
import type { AssistantDeltaEvent } from './transcript-vm';

// Token-level assistant streaming: a small SSE subscription carrying `session.message.delta` for ONE
// session, opened only by the surface that renders a live preview (the open chat).
//
// WHY IT IS NOT ON THE SHARED STREAM (features/live/LiveEventsProvider): the server delivers deltas
// only to a subscription that names their session — an app-wide, unscoped stream would take every
// session's previews into its 256-slot server queue and drop-oldest the status / thread / task
// events it exists to deliver (agent-server `domain/ui-service/subscribe.ts`, SESSION_SCOPED_ONLY).
// This is the same treatment `executions.log` already gets: id-scoped, higher volume, and open only
// while its surface is. Two connections on a loaded workbench, well inside the HTTP/1.1 per-origin
// cap that the shared stream exists to protect.
//
// The handler is read through a ref, so a re-render never touches the connection; it re-opens only
// when the session changes or streaming is switched off.

export function useAssistantDeltaStream(
  sessionId: string,
  enabled: boolean,
  onDelta: (ev: AssistantDeltaEvent) => void,
): void {
  const client = useTRPCClient();
  const handlerRef = useRef(onDelta);
  handlerRef.current = onDelta;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const sub = client.subscribe.subscribe(
      { events: [...ASSISTANT_DELTA_EVENTS], sessionId },
      {
        onData: (raw: unknown) => {
          const ev = raw as { type?: string; payload?: AssistantDeltaEvent } | undefined;
          if (!ev || ev.type !== 'session.message.delta' || !ev.payload) return;
          handlerRef.current(ev.payload);
        },
        // A dropped delta stream costs a preview, nothing else: the authoritative `session.message`
        // still arrives on the shared stream. Nothing to recover, so no reconnect bookkeeping here.
        onError: () => {},
      },
    );
    return () => sub.unsubscribe();
  }, [client, sessionId, enabled]);
}
