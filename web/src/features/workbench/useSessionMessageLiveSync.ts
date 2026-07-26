import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveConnection, useLiveEvents } from '@/features/live/LiveEventsProvider';
import { SESSION_LIVE_EVENTS } from '@/features/live/live-events';
import type { SessionTranscript } from '@cortex-agent/ui-contract';
import type { LiveSessionMessage, PendingUserMessage, StreamingBlock } from './transcript-vm';
import {
  resolveRunning, resolveBackgroundRunning, applyAssistantDelta, endStreamingBlock,
  applyDelivered, reconcilePendingUserMessages,
} from './transcript-vm';
import { useAssistantDeltaStream } from './useAssistantDeltaStream';

// Live `session.message` feed for the center chat (S4 chat, task aba0). Listens on the SHARED live
// stream (`features/live/LiveEventsProvider`) scoped to `sessionId` — the scope filter reproduces the
// server's per-session post-filter client-side, so events for other sessions are dropped exactly as
// before — and accumulates each event into a bounded live-tail buffer so the assistant output streams
// into the transcript immediately, then invalidates the authoritative `sessions.transcript` query so
// the finalized history reconciles (buildTranscriptRows de-dups the tail against it). All buffer/row
// logic lives in the pure transcript-vm (unit-tested); this is the thin React glue.
//
// Running state is snapshot + delta (fix: running was lost on session switch / reload / reconnect):
//   snapshot — the caller passes SessionInfo.running from sessions.list (authoritative at query time);
//   delta    — the `session.status` event (agent-runner turn start/finally) overrides once received.
// Precedence lives in the pure `resolveRunning` (transcript-vm, unit-tested).
//
// Each event arrives as a UiEvent wrapper { type:'session.message', ts, payload:{ sessionId, channel,
// role, text, toolName?, toolInput? } } (subscribe.ts wraps the bus event under `payload`).
//
// A message sent while a turn is already running is written into that turn's backend stdin, which
// only QUEUES it there — the model reads it at the next agent-loop boundary, seconds later or after
// the current turn's result. Its `session.message` therefore arrives marked `pending` and is kept in
// `pendingUser`, OUT of the ordered tail: nothing the agent is emitting was produced with it. The
// `session.message.delivered` event is the moment it was read; it moves the message into the tail
// under the ts it was recorded with, which is also what a transcript refetch returns, so the two
// dedupe as one row. A delivered event lost to a dropped frame self-heals — any pending message the
// refetched transcript already holds is dropped (`reconcilePendingUserMessages`).

const TAIL_CAP = 60; // bound the live buffer; older events reconcile via the transcript refetch
const STREAM_IDLE_MS = 2500; // treat the session as streaming until this quiet gap after the last event

export interface SessionLiveState {
  liveTail: LiveSessionMessage[];
  streaming: boolean;
  /** The session's REAL running state: the live `session.status` event once received, else the
   *  sessions.list snapshot (`snapshotRunning`), else the message-stream heuristic. This is what
   *  the chat's running/idle indicator should use. */
  running: boolean;
  /** True while the foreground turn has ended but a background task (run_in_background Bash /
   *  background subagent) is still running and may spontaneously re-invoke the model — the
   *  `session.status` `backgroundRunning` flag (web bg-hold). `running` stays true throughout, so
   *  the indicator lets the composer show a distinct "background" state instead of a plain turn.
   *  Snapshot + delta (fix: the state was delta-only and lost on session switch / reload / app
   *  restart): the live event wins once received; before that the caller-passed
   *  `SessionInfo.backgroundRunning` snapshot governs. */
  backgroundRunning: boolean;
  /** The live agent-turn count from the `session.turn` delta (null until the first event for this
   *  session). The caller resolves it against the `SessionInfo.numTurns` snapshot via `resolveTurns`. */
  liveTurns: number | null;
  /** Text accumulated for the assistant block being written right now, or null when nothing is
   *  streaming. Pass it to `buildTranscriptRows` as `streamingText`. Always null unless the caller
   *  opted into deltas — every other surface renders complete messages exactly as before. */
  streamingText: string | null;
  /** Messages sent into a turn already running and written to its backend, which the model has not
   *  read yet. Kept OUT of `liveTail` on purpose: they are not in conversation history and nothing
   *  the agent is currently emitting was produced with them, so a surface that shows them must pin
   *  them below its live rows (`buildTranscriptRows` `pendingUser`). Each moves into `liveTail`
   *  under its committed ts the moment the backend reads it. */
  pendingUser: PendingUserMessage[];
}

export interface SessionLiveSyncOptions {
  /**
   * Render assistant text as it is generated, by opening a session-scoped `session.message.delta`
   * subscription (see useAssistantDeltaStream). Opt-in per surface: it costs one SSE connection, so
   * only a chat that actually shows a live preview should ask for it — not thread step cards or
   * background readers, of which several can be mounted at once.
   */
  deltas?: boolean;
  /**
   * The authoritative transcript this surface is rendering. Used only to self-heal `pendingUser`: a
   * `session.message.delivered` lost to a dropped SSE frame would otherwise leave a permanently
   * dimmed row, so any pending message the refetched transcript already contains is dropped.
   */
  transcript?: SessionTranscript | null;
}

export function useSessionMessageLiveSync(
  sessionId: string,
  snapshotRunning?: boolean,
  snapshotBackgroundRunning?: boolean,
  options: SessionLiveSyncOptions = {},
): SessionLiveState {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [liveTail, setLiveTail] = useState<LiveSessionMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  // Delta from the backend `session.status` event (real turn lifecycle). Null until the first status
  // event arrives for this session — until then the snapshot (then the stream heuristic) governs.
  const [statusRunning, setStatusRunning] = useState<boolean | null>(null);
  // Background-task flag from the `session.status` delta (web bg-hold). Null until the first status
  // event for this session (reset on switch) — before that the sessions.list snapshot governs.
  const [statusBackground, setStatusBackground] = useState<boolean | null>(null);
  // Live agent-turn count from the `session.turn` delta. Null until the first event for this session.
  const [liveTurns, setLiveTurns] = useState<number | null>(null);
  // The assistant block being previewed token by token (null whenever nothing is streaming).
  const [streamingBlock, setStreamingBlock] = useState<StreamingBlock | null>(null);
  // Messages written into the running turn's backend that the model has not read yet. Deliberately
  // a separate list, not part of the ordered tail — see SessionLiveState.pendingUser.
  const [pendingUser, setPendingUser] = useState<PendingUserMessage[]>([]);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `pendingUser` synchronously. Committing a message has to read the current list AND
  // append to the tail in one go; doing that from inside a state updater would double-append the
  // moment React invoked it twice, so the list is read from here and written through `setPending`.
  const pendingRef = useRef<PendingUserMessage[]>([]);
  const setPending = useCallback((next: PendingUserMessage[]): void => {
    pendingRef.current = next;
    setPendingUser(next);
  }, []);

  // Session switch resets every delta; the snapshot then governs until the first event lands.
  useEffect(() => {
    setLiveTail([]);
    setStreaming(false);
    setStatusRunning(null);
    setStatusBackground(null);
    setLiveTurns(null);
    setStreamingBlock(null);
    setPending([]);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [sessionId, setPending]);

  // Self-heal: the live stream is lossy by design, so a delivered event can be dropped. Any pending
  // message the authoritative transcript already holds was read and recorded — stop dimming it.
  // `reconcilePendingUserMessages` returns the same array when nothing matched, so this cannot loop.
  const transcript = options.transcript;
  useEffect(() => {
    if (!transcript) return;
    const next = reconcilePendingUserMessages(pendingRef.current, transcript);
    if (next !== pendingRef.current) setPending(next);
  }, [transcript, setPending]);

  // Token-level preview. Accumulate only — the transcript query is NOT invalidated per delta (a
  // reply produces dozens of these, and none of them changes persisted history).
  useAssistantDeltaStream(sessionId, !!options.deltas, (ev) => {
    setStreamingBlock((prev) => applyAssistantDelta(prev, ev));
  });

  // Reconnect recovery: after a stream drop (sleep, network blip) events are lost for good — when the
  // shared stream reconnects, refetch the authoritative snapshot + transcript. `reconnectEpoch` only
  // changes on a REAL reconnect (not the first connect), which is what the old per-hook
  // `wasConnected` latch expressed.
  const { reconnectEpoch } = useLiveConnection();
  useEffect(() => {
    if (reconnectEpoch === 0 || !sessionId) return;
    queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
    queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
  }, [reconnectEpoch, sessionId, queryClient, trpc]);

  useLiveEvents(
    SESSION_LIVE_EVENTS,
    (raw) => {
      if (!sessionId) return;
      // Delta running signal — real turn start/end from the agent-runner.
      if (raw.type === 'session.status') {
        const s = raw.payload as { running?: boolean; backgroundRunning?: boolean } | undefined;
        const r = !!s?.running;
        setStatusRunning(r);
        // Background-task hold: running stays true but the foreground turn is done and a
        // background task may still stream a continuation. Cleared whenever running:false lands.
        setStatusBackground(r && !!s?.backgroundRunning);
        if (r) {
          // A fresh turn starts its own turn count — drop the previous run's live value so the
          // composer doesn't flash the last count before this run's first progress event lands.
          setLiveTurns(null);
        } else {
          // Turn ended — collapse the heuristic immediately so idle is instant, not a 2.5s tail.
          setStreaming(false);
          // …and drop any preview the turn left behind (cancelled turn, error, a block whose
          // complete message never arrived). An idle session must never show a live caret.
          setStreamingBlock(null);
          if (idleTimer.current) clearTimeout(idleTimer.current);
        }
        // Keep the sessions.list snapshot (running dots, labels, ordering) in sync on BOTH
        // edges so the left rail reflects the turn without waiting for a focus refetch.
        queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
        return;
      }
      // Message edit + rewind (sessions.rewind, possibly from ANOTHER client): the transcript
      // changed SHAPE — the buffered live tail may hold now-superseded messages, so drop it
      // entirely and refetch the authoritative transcript.
      if (raw.type === 'session.rewound') {
        setLiveTail([]);
        setStreamingBlock(null);
        setPending([]);
        queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
        queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
        return;
      }
      // Interaction entity state change (created / answered / approved / expired / …):
      // events are hints, queries are truth — refetch the transcript; every connected
      // client converges on the entity's current status (cards appear, resolve, gray out).
      if (raw.type === 'session.interaction') {
        queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
        queryClient.invalidateQueries(trpc.sessions.pendingInteraction.queryFilter());
        return;
      }
      // A message that was only QUEUED inside the backend has now been read by the model (or its
      // injection window closed). It enters the stream HERE, after everything already emitted, and
      // under the ts it was recorded with — which is what a transcript refetch returns, so the live
      // row and the fetched row resolve to one.
      if (raw.type === 'session.message.delivered') {
        const p = raw.payload as { messageTs?: string; committedTs?: string } | undefined;
        if (!p) return;
        const { pending, committed } = applyDelivered(pendingRef.current, { ...p, sessionId });
        if (!committed) return; // an ack for a row this client never showed
        setPending(pending);
        setLiveTail((tail) => {
          const next = [...tail, committed];
          return next.length > TAIL_CAP ? next.slice(next.length - TAIL_CAP) : next;
        });
        // It is in conversation history now, so the authoritative transcript has it too.
        queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
        return;
      }
      // Live agent-turn delta — the real turn count that grows as the agent works.
      if (raw.type === 'session.turn') {
        const s = raw.payload as { numTurns?: number } | undefined;
        if (typeof s?.numTurns === 'number') setLiveTurns(s.numTurns);
        return;
      }
      const p = raw.payload as
        | { sessionId?: string; role?: string; text?: string; toolName?: string; toolInput?: string; ts?: string; blockId?: string; pending?: boolean; attachments?: LiveSessionMessage['attachments'] }
        | undefined;
      if (!p || (p.role !== 'user' && p.role !== 'assistant' && p.role !== 'tool')) return;
      // A message written into a running turn's backend, which the model has not read yet. It holds
      // no history entry, and everything the agent is emitting right now was produced without it —
      // so it is held out of the ordered tail entirely until its delivered event commits it. It
      // also settles nothing: it is not agent output, so it neither marks the session streaming nor
      // invalidates the transcript (there is nothing there to reconcile against).
      if (p.role === 'user' && p.pending) {
        setPending([...pendingRef.current, {
          ts: p.ts ?? new Date().toISOString(),
          text: p.text ?? '',
          attachments: p.attachments,
        }]);
        return;
      }
      const msg: LiveSessionMessage = {
        sessionId: p.sessionId ?? sessionId,
        role: p.role,
        text: p.text ?? '',
        toolName: p.toolName,
        toolInput: p.toolInput,
        ts: p.ts ?? new Date().toISOString(),
        blockId: p.blockId,
        attachments: p.attachments,
      };
      // The authoritative text for a previewed block: retire the preview in the SAME state update
      // that appends the message, so the row is replaced rather than briefly doubled.
      if (p.role === 'assistant') {
        setStreamingBlock((prev) => endStreamingBlock(prev, p.blockId));
      }
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
    { sessionId },
  );

  // Snapshot + delta: event wins once received; snapshot restores state before that; heuristic last.
  const running = resolveRunning(statusRunning, snapshotRunning, streaming);
  const backgroundRunning = resolveBackgroundRunning(statusBackground, snapshotBackgroundRunning);
  return { liveTail, streaming, running, backgroundRunning, liveTurns, streamingText: streamingBlock?.text ?? null, pendingUser };
}
