import { useEffect, useRef, useState } from 'react';
import { useTRPCClient } from '@/lib/trpc';
import { ASSISTANT_DELTA_EVENTS, liveRetryDelayMs } from '@/features/live/live-events';
import type { AssistantDeltaEvent } from '@/features/session/transcript/transcript-vm';

// Token-level assistant streaming: a small SSE subscription carrying `session.message.delta` for ONE
// session, opened only by the surface that renders a live preview (the open chat).
//
// WHY IT IS NOT ON THE SHARED STREAM (features/live/LiveEventsProvider): the server delivers deltas
// only to a subscription that names their session — an app-wide, unscoped stream would take every
// session's previews into its 256-slot server queue and drop-oldest the status / thread / task
// events it exists to deliver (agent-server `domain/ui-service/subscribe.ts`, SESSION_SCOPED_ONLY).
// So this one is id-scoped and open only while the chat that renders it is — the other high-volume
// surface, the execution log drawer, goes further and opens nothing at all (it polls
// `executions.get`). Two connections on a loaded workbench, well inside the HTTP/1.1 per-origin
// cap that the shared stream exists to protect.
//
// The handler is read through a ref, so a re-render never touches the connection; it re-opens only
// when the session changes, when streaming is switched off, or on the backoff below.

export function useAssistantDeltaStream(
  sessionId: string,
  enabled: boolean,
  onDelta: (ev: AssistantDeltaEvent) => void,
): void {
  const client = useTRPCClient();
  const handlerRef = useRef(onDelta);
  handlerRef.current = onDelta;
  // Re-open generation + backoff state, exactly as the shared stream keeps them
  // (features/live/LiveEventsProvider): a terminal error ends the tRPC observable, so without a
  // retry the open chat silently stops previewing tokens until you switch sessions and back.
  const [generation, setGeneration] = useState(0);
  const failuresRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A different session (or a toggle of streaming) is a fresh start, not the next failed attempt.
  useEffect(() => {
    failuresRef.current = 0;
  }, [sessionId, enabled]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    const sub = client.subscribe.subscribe(
      { events: [...ASSISTANT_DELTA_EVENTS], sessionId },
      {
        onConnectionStateChange: (s: { state: string }) => {
          if (s.state === 'pending') failuresRef.current = 0;
        },
        onData: (raw: unknown) => {
          const ev = raw as { type?: string; payload?: AssistantDeltaEvent } | undefined;
          if (!ev || ev.type !== 'session.message.delta' || !ev.payload) return;
          handlerRef.current(ev.payload);
        },
        // Losing this stream costs only the token-level preview — the authoritative
        // `session.message` still arrives on the shared stream — but "replies stop streaming until
        // you click away and back" is exactly what a dropped preview looks like to the user, so it
        // re-opens on the same backoff instead of staying dead.
        onError: () => {
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
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      sub.unsubscribe();
    };
  }, [client, sessionId, enabled, generation]);
}
