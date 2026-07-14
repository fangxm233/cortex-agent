import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import type { LiveSessionMessage } from './transcript-vm';
import { resolveRunning } from './transcript-vm';

// Live `session.message` stream for the center chat (S4 chat, task aba0). Opens one SSE subscription
// scoped to `sessionId` and accumulates each event into a bounded live-tail buffer so the assistant
// output streams into the transcript immediately, and invalidates the authoritative
// `sessions.transcript` query so the finalized history reconciles (buildTranscriptRows de-dups the
// tail against it). Mirrors features/thread/useThreadGetLiveSync + features/execution/
// useExecutionLogStream — all buffer/row logic lives in the pure transcript-vm (unit-tested); this is
// the thin React/SSE glue.
//
// Running state is snapshot + delta (fix: running was lost on session switch / reload / reconnect):
//   snapshot — the caller passes SessionInfo.running from sessions.list (authoritative at query time);
//   delta    — the `session.status` event (agent-runner turn start/finally) overrides once received.
// Precedence lives in the pure `resolveRunning` (transcript-vm, unit-tested).
//
// Each event arrives as a UiEvent wrapper { type:'session.message', ts, payload:{ sessionId, channel,
// role, text, toolName?, toolInput? } } (subscribe.ts wraps the bus event under `payload`).

const TAIL_CAP = 60; // bound the live buffer; older events reconcile via the transcript refetch
const STREAM_IDLE_MS = 2500; // treat the session as streaming until this quiet gap after the last event

export interface SessionLiveState {
  liveTail: LiveSessionMessage[];
  streaming: boolean;
  /** The session's REAL running state: the live `session.status` event once received, else the
   *  sessions.list snapshot (`snapshotRunning`), else the message-stream heuristic. This is what
   *  the chat's running/idle indicator should use. */
  running: boolean;
}

export function useSessionMessageLiveSync(sessionId: string, snapshotRunning?: boolean): SessionLiveState {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [liveTail, setLiveTail] = useState<LiveSessionMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  // Delta from the backend `session.status` event (real turn lifecycle). Null until the first status
  // event arrives for this session — until then the snapshot (then the stream heuristic) governs.
  const [statusRunning, setStatusRunning] = useState<boolean | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLiveTail([]);
    setStreaming(false);
    setStatusRunning(null);
    if (!sessionId) return;

    // Reconnect recovery: after an SSE drop (sleep, network blip) events are lost for good — on
    // re-entering the 'pending' (connected) state, refetch the authoritative snapshot + transcript.
    let wasConnected = false;

    const sub = client.subscribe.subscribe(
      { events: ['session.message', 'session.status'], sessionId },
      {
        onConnectionStateChange: (state: { state: string }) => {
          if (state.state !== 'pending') return;
          if (wasConnected) {
            queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
            queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
          }
          wasConnected = true;
        },
        onData: (raw: { type?: string; payload?: unknown }) => {
          // Delta running signal — real turn start/end from the agent-runner.
          if (raw.type === 'session.status') {
            const s = raw.payload as { running?: boolean } | undefined;
            const r = !!s?.running;
            setStatusRunning(r);
            if (!r) {
              // Turn ended — collapse the heuristic immediately so idle is instant, not a 2.5s tail.
              setStreaming(false);
              if (idleTimer.current) clearTimeout(idleTimer.current);
            }
            // Keep the sessions.list snapshot (running dots, labels, ordering) in sync on BOTH
            // edges so the left rail reflects the turn without waiting for a focus refetch.
            queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
            return;
          }
          const p = raw.payload as
            | { sessionId?: string; role?: string; text?: string; toolName?: string; toolInput?: string; ts?: string; attachments?: LiveSessionMessage['attachments'] }
            | undefined;
          if (!p || (p.role !== 'user' && p.role !== 'assistant' && p.role !== 'tool')) return;
          const msg: LiveSessionMessage = {
            sessionId: p.sessionId ?? sessionId,
            role: p.role,
            text: p.text ?? '',
            toolName: p.toolName,
            toolInput: p.toolInput,
            ts: p.ts ?? new Date().toISOString(),
            attachments: p.attachments,
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

  // Snapshot + delta: event wins once received; snapshot restores state before that; heuristic last.
  const running = resolveRunning(statusRunning, snapshotRunning, streaming);
  return { liveTail, streaming, running };
}
