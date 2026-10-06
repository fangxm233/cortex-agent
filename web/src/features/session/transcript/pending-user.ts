import type { SessionTranscript, SystemTurnOrigin } from '@cortex-agent/ui-contract';
import type { AttachmentMeta as Attachment } from '@/features/attachments/types';
import type { LiveSessionMessage } from './live-message';

// ── A user message the model has not read yet (`pending` / `session.message.delivered`) ─────────
//
// Sending while a turn is running writes the message into the backend's stdin, which only QUEUES it
// there: the model reads it at the next agent-loop boundary, which can be seconds away or after the
// current turn has finished answering something else entirely. Until it is read, the message is not
// part of the conversation — everything the agent is emitting was produced without it — so it is
// held OUT of the ordered stream and shown as a provisional row pinned to the bottom. The delivered
// event is the moment it was read: it enters the stream there, under the ts it was recorded with.

/** An injected message surfaced but not yet read by the model. `ts` is the write-time key the
 *  `session.message` carried; it is replaced by the committed ts when the delivered event lands. */
export interface PendingUserMessage {
  /** Stable durable identity. Absent only for live events from older servers. */
  id?: string;
  ts: string;
  text: string;
  attachments?: Attachment[];
  /** Cortex authored this turn — it renders as a system hint even while still unread. */
  systemOrigin?: SystemTurnOrigin;
}

/** A `session.message.delivered` payload. */
export interface DeliveredEvent {
  sessionId?: string;
  /** Stable durable identity. When present it takes precedence over the legacy timestamp key. */
  pendingId?: string;
  /** The pending row's key. */
  messageTs?: string;
  /** The conversation-history key it is re-keyed to — what a transcript refetch returns. */
  committedTs?: string;
}

/**
 * Move the acked message out of the pending list and into the ordered stream. The returned
 * `committed` message is appended to the LIVE TAIL, i.e. after everything already emitted — which is
 * exactly where the model read it. Keyed by `committedTs` so it dedupes against the same record when
 * the transcript refetches. An ack for an unknown message changes nothing (a stale ack, or one for a
 * row this client never saw); a server that sent no `committedTs` falls back to the pending key.
 */
export function applyDelivered(
  pending: PendingUserMessage[],
  ev: DeliveredEvent,
): { pending: PendingUserMessage[]; committed: LiveSessionMessage | null } {
  const { messageTs, pendingId } = ev;
  if (!pendingId && !messageTs) return { pending, committed: null };
  const idx = pendingId
    ? pending.findIndex((p) => p.id === pendingId)
    : pending.findIndex((p) => p.ts === messageTs);
  if (idx === -1) return { pending, committed: null };
  const entry = pending[idx];
  return {
    pending: pending.filter((_, i) => i !== idx),
    committed: {
      sessionId: ev.sessionId ?? '',
      role: 'user',
      text: entry.text,
      ts: ev.committedTs || entry.ts,
      attachments: entry.attachments,
      ...(entry.systemOrigin ? { systemOrigin: entry.systemOrigin } : {}),
    },
  };
}

/**
 * Drop pending entries the authoritative transcript already holds. The delta/live streams are lossy
 * by design, so a delivered event can be lost to a dropped frame — without this the row would stay
 * dimmed forever even though the message was read and recorded. A record only clears a pending entry
 * if it was written at or after the send (an identical message sent EARLIER in the session is a
 * different message), and each record clears at most one entry, so sending the same text twice needs
 * two records. Returns the input array unchanged when nothing matched, so a refetch cannot loop the
 * caller's state.
 */
export function reconcilePendingUserMessages(
  pending: PendingUserMessage[],
  transcript: SessionTranscript | undefined | null,
  deliveredIds?: ReadonlySet<string>,
): PendingUserMessage[] {
  if (!transcript) return pending;
  // Current servers include an explicit durable snapshot (including []); it is authoritative for
  // reload, session switch, reconnect, and another device's commit. A delivered-id tombstone blocks
  // an older in-flight snapshot response from resurrecting a row after its later SSE commit. Undefined
  // means an older server, where the legacy committed-row reconciliation below is the only signal.
  if (transcript.pendingUserMessages !== undefined) {
    return transcript.pendingUserMessages
      .filter((message) => !deliveredIds?.has(message.id))
      .map((message) => ({ ...message }));
  }
  if (pending.length === 0) return pending;
  const records: { text: string; ts: string }[] = [];
  for (const turn of transcript.turns) {
    for (const m of turn.messages) {
      if (m.type === 'user') records.push({ text: m.text ?? '', ts: m.ts });
    }
  }
  const kept: PendingUserMessage[] = [];
  for (const p of pending) {
    const i = records.findIndex((r) => r.text === p.text && r.ts >= p.ts);
    if (i === -1) kept.push(p);
    else records.splice(i, 1);
  }
  return kept.length === pending.length ? pending : kept;
}
