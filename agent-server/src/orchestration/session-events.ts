// input:  session lifecycle payloads + the shared EventBus (via job-registry ctx)
// output: message/pending-id/delta/status/turn/rewind publishers
// pos:    orchestration bus seam; persistence remains bus-free and missing bus is a no-op
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';

export interface SessionMessagePayload {
  sessionId: string;
  channel: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
  toolInput?: string;
  attachments?: AttachmentMeta[];
  /** Optional shared timestamp — when provided, the EventBus event carries the same
   *  `ts` as the conversation-history entry so the web UI's content-based de-dup
   *  (transcript query vs live-tail) produces identical keys for the same message. */
  ts?: string;
  /** Set on an assistant message whose text was streamed as `session.message.delta` events first.
   *  The web chat replaces that block's accumulated preview with this text instead of adding a
   *  second row. Absent whenever nothing streamed (non-Claude backend, kill switch, older CLI). */
  blockId?: string;
  /** Set on a user message injected into a live turn and not yet read by the model. It carries no
   *  history entry yet — the client shows it as a provisional row until the matching
   *  `session.message.delivered` commits it. Absent on every ordinary message. */
  pending?: boolean;
  /** Durable active-record identity; stable across reloads/devices until delivery. */
  pendingId?: string;
}

/** Tell an open transcript to refetch after sensitive DEBUG metadata is durably persisted.
 *  Deliberately carries no prompt, input, result, or tool id; the transcript query remains the
 *  authenticated and DEBUG-gated source of truth. */
export function publishSessionDebugUpdated(p: { sessionId: string; channel: string }): void {
  jobCtx.bus?.publish({ type: 'session.debug.updated', sessionId: p.sessionId, channel: p.channel });
}

export function publishSessionMessage(p: SessionMessagePayload): void {
  jobCtx.bus?.publish({
    type: 'session.message',
    sessionId: p.sessionId,
    channel: p.channel,
    role: p.role,
    text: p.text,
    ...(p.toolName !== undefined ? { toolName: p.toolName } : {}),
    ...(p.toolInput !== undefined ? { toolInput: p.toolInput } : {}),
    ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
    ...(p.ts !== undefined ? { ts: p.ts } : {}),
    ...(p.blockId !== undefined ? { blockId: p.blockId } : {}),
    ...(p.pending !== undefined ? { pending: p.pending } : {}),
    ...(p.pendingId !== undefined ? { pendingId: p.pendingId } : {}),
  });
}

/** Emit one coalesced chunk of an assistant text block that is still being generated (token-level
 *  streaming). Published by the agent-runner through the delta coalescer, for Web UI sessions only —
 *  Slack / Feishu / Ink-TUI render complete messages and never see these. The finalizing
 *  `session.message` carrying the same `blockId` remains authoritative: the UI replaces the
 *  accumulated preview with it. Nothing here is persisted. No-op when no bus is wired. */
export function publishSessionMessageDelta(p: {
  sessionId: string;
  channel: string;
  blockId: string;
  /** The increment since this block's previous event — never the accumulated total. */
  text: string;
  /** 0-based, per blockId; lets a client notice it missed one. */
  seq: number;
}): void {
  jobCtx.bus?.publish({
    type: 'session.message.delta',
    sessionId: p.sessionId,
    channel: p.channel,
    blockId: p.blockId,
    text: p.text,
    seq: p.seq,
  });
}

/** Emit a `session.message.delivered` event: a message injected into a turn already in flight has
 *  now been consumed by the model (or its injection window closed without that happening). The
 *  injecting publish surfaces the message immediately as a PENDING row — the transcript shows it
 *  while the turn is still running — but it is only queued inside the backend at that point and
 *  holds no history entry. This event is the commit: `messageTs` identifies the pending row,
 *  `committedTs` is the history ts it is re-keyed to, which is also what a transcript refetch
 *  returns, so the live row and the fetched row dedupe as one. Published by mid-turn-inject.ts.
 *  No-op when no bus is wired. */
export function publishSessionMessageDelivered(p: { sessionId: string; channel: string; pendingId: string; messageTs: string; committedTs: string }): void {
  jobCtx.bus?.publish({
    type: 'session.message.delivered',
    sessionId: p.sessionId,
    channel: p.channel,
    pendingId: p.pendingId,
    messageTs: p.messageTs,
    committedTs: p.committedTs,
  });
}

/** Emit the REAL agent-turn count of a session's in-flight turn (S4 chat composer). Published by the
 *  agent-runner on each `turn_progress` (and the terminal `turn_complete`) during an interactive turn,
 *  so the Web composer shows the live agent turn count that grows as the agent works — not the count of
 *  user-message rounds. `numTurns` is the adapter's cumulative turn count within the current run. The
 *  Web chat subscribes to this (scoped by sessionId) as the delta over the `SessionInfo.numTurns`
 *  snapshot (snapshot + delta, mirroring `session.status`). No-op when no bus is wired. */
export function publishSessionTurn(p: { sessionId: string; channel: string; numTurns: number }): void {
  jobCtx.bus?.publish({
    type: 'session.turn',
    sessionId: p.sessionId,
    channel: p.channel,
    numTurns: p.numTurns,
  });
}

/** Emit a `session.rewound` event (message edit + rewind): the session's transcript changed SHAPE —
 *  every turn from `turnIndex` onward was rolled back. Live web clients drop their buffered live
 *  tails (which may hold now-superseded messages) and refetch the transcript. Published by
 *  session-rewind.ts before the edited message is re-sent. No-op when no bus is wired. */
export function publishSessionRewound(p: { sessionId: string; channel: string; turnIndex: number }): void {
  jobCtx.bus?.publish({
    type: 'session.rewound',
    sessionId: p.sessionId,
    channel: p.channel,
    turnIndex: p.turnIndex,
  });
}

/** Emit the REAL running state of a session's turn (S4 chat running indicator). Published by the
 *  agent-runner at the start (running:true) and end (running:false, in a finally) of each interactive
 *  turn — the single seam covering every channel (web / Slack / Feishu). The Web chat subscribes to
 *  this (scoped by sessionId) so its running/idle state reflects the real turn, not a client-side
 *  heuristic. No-op when no bus is wired.
 *
 *  `backgroundRunning` (optional): the turn's foreground work finished but a background task
 *  (run_in_background Bash / background subagent) is still running and may spontaneously re-invoke
 *  the model. The web bg-hold (web-bg-hold.ts) keeps `running:true, backgroundRunning:true` for the
 *  whole wait so the session is NOT prematurely marked idle, then publishes `running:false` once the
 *  background work finishes. Omitted (undefined) on the normal turn-start / turn-end edges. */
export function publishSessionStatus(p: { sessionId: string; channel: string; running: boolean; backgroundRunning?: boolean }): void {
  jobCtx.bus?.publish({
    type: 'session.status',
    sessionId: p.sessionId,
    channel: p.channel,
    running: p.running,
    ...(p.backgroundRunning !== undefined ? { backgroundRunning: p.backgroundRunning } : {}),
  });
}
