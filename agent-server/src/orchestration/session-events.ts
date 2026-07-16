// input:  session-message payload + the shared EventBus (via job-registry ctx)
// output: publishSessionMessage — emits a `session.message` CortexEvent for the S4 chat live stream
// pos:    orch/ — published at the conversation-history append points in agent-runner. Reads the
//         bus from the shared job-registry ctx (same seam thread-callback uses), so the repo stays
//         bus-free (L1) and the publish lives in the orchestration layer. No-op if no bus is wired.

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
