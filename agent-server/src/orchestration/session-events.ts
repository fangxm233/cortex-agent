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

/** Emit the REAL running state of a session's turn (S4 chat running indicator). Published by the
 *  agent-runner at the start (running:true) and end (running:false, in a finally) of each interactive
 *  turn — the single seam covering every channel (web / Slack / Feishu). The Web chat subscribes to
 *  this (scoped by sessionId) so its running/idle state reflects the real turn, not a client-side
 *  heuristic. No-op when no bus is wired. */
export function publishSessionStatus(p: { sessionId: string; channel: string; running: boolean }): void {
  jobCtx.bus?.publish({
    type: 'session.status',
    sessionId: p.sessionId,
    channel: p.channel,
    running: p.running,
  });
}
