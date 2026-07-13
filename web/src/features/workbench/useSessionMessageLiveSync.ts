import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import type { LiveSessionMessage } from './transcript-vm';

// Live `session.message` stream for the center chat (S4 chat, task aba0). Opens one SSE subscription
// scoped to `sessionId` and accumulates each event into a bounded live-tail buffer so the assistant
// output streams into the transcript immediately, and invalidates the authoritative
// `sessions.transcript` query so the finalized history reconciles (buildTranscriptRows de-dups the
// tail against it). Mirrors features/thread/useThreadGetLiveSync + features/execution/
// useExecutionLogStream — all buffer/row logic lives in the pure transcript-vm (unit-tested); this is
// the thin React/SSE glue.
//
// Each event arrives as a UiEvent wrapper { type:'session.message', ts, payload:{ sessionId, channel,
// role, text, toolName?, toolInput? } } (subscribe.ts wraps the bus event under `payload`).

const TAIL_CAP = 60; // bound the live buffer; older events reconcile via the transcript refetch
const STREAM_IDLE_MS = 2500; // treat the session as streaming until this quiet gap after the last event

export interface SessionLiveState {
  liveTail: LiveSessionMessage[];
  streaming: boolean;
  /** The session's REAL running state: true from the authoritative `session.status` event
   *  (agent-runner turn start/finally), OR the message-stream heuristic as a fallback when no status
   *  has been received. This is what the chat's running/idle indicator should use. */
  running: boolean;
}

export function useSessionMessageLiveSync(sessionId: string): SessionLiveState {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [liveTail, setLiveTail] = useState<LiveSessionMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  // Authoritative running from the backend `session.status` event (real turn lifecycle). Null until
  // the first status event arrives for this session — until then we fall back to the stream heuristic.
  const [statusRunning, setStatusRunning] = useState<boolean | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLiveTail([]);
    setStreaming(false);
    setStatusRunning(null);
    if (!sessionId) return;

    const sub = client.subscribe.subscribe(
      { events: ['session.message', 'session.status'], sessionId },
      {
        onData: (event: { type?: string; payload?: unknown }) => {
          // Authoritative running signal — real turn start/end from the agent-runner.
          if (event.type === 'session.status') {
            const s = event.payload as { running?: boolean } | undefined;
            const r = !!s?.running;
            setStatusRunning(r);
            if (!r) {
              // Turn ended — collapse the heuristic immediately so idle is instant, not a 2.5s tail.
              setStreaming(false);
              if (idleTimer.current) clearTimeout(idleTimer.current);
            }
            return;
          }
          const p = event.payload as
            | { sessionId?: string; role?: string; text?: string; toolName?: string; toolInput?: string; ts?: string }
            | undefined;
          if (!p || (p.role !== 'user' && p.role !== 'assistant' && p.role !== 'tool')) return;
          const msg: LiveSessionMessage = {
            sessionId: p.sessionId ?? sessionId,
            role: p.role,
            text: p.text ?? '',
            toolName: p.toolName,
            toolInput: p.toolInput,
            ts: p.ts ?? new Date().toISOString(),
          };
          setLiveTail((prev) => {
            const next = [...prev, msg];
            return next.length > TAIL_CAP ? next.slice(next.length - TAIL_CAP) : next;
          });
          setStreaming(true);
          if (idleTimer.current) clearTimeout(idleTimer.current);
          idleTimer.current = setTimeout(() => setStreaming(false), STREAM_IDLE_MS);
          // Reconcile the authoritative history (finalized turns) — the tail de-dups against it.
          queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
        },
      },
    );

    return () => {
      sub.unsubscribe();
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [client, queryClient, trpc, sessionId]);

  // Prefer the authoritative status; fall back to the stream heuristic only before any status arrives.
  const running = statusRunning ?? streaming;
  return { liveTail, streaming, running };
}
