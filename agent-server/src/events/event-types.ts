// input:  ChatNoticeLevel and SessionContextUsage
// output: CortexEvent and AuthErrorKind contracts
// pos:    Typed event contract for the shared EventBus
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ChatNoticeLevel, SessionContextUsage } from '@core/types/agent-types.js';

export type AuthErrorKind = 'login_required' | 'oauth_expired' | 'invalid_api_key' | 'unauthorized' | 'invalid_grant';

// ── User-facing events (§5.1) ────────────────────────────────────────────────

/** All CortexEvent variants.  `ts` is ISO-8601, injected by EventBus.publish(). */
export type CortexEvent =
  // Message / interaction
  | { type: 'message.received';       ts: string; channel: string; user: string; text: string }
  | { type: 'message.edited';         ts: string; channel: string; user: string; text: string }
  // `pending` marks a user message written into a live turn's backend stdin but not yet read by the
  // model. It is NOT in conversation history yet — clients show it as a provisional row pinned below
  // everything the agent is currently emitting, and `session.message.delivered` later commits it.
  | { type: 'session.message';        ts: string; sessionId: string; channel: string; role: 'user' | 'assistant' | 'tool'; text: string; toolName?: string; toolInput?: string; blockId?: string; noticeLevel?: ChatNoticeLevel; pending?: boolean; pendingId?: string; attachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' }[] }
  // Token-level preview of an assistant text block still being generated. `text` is the INCREMENT
  // since the previous event of that `blockId`, never the accumulated total; `seq` starts at 0 per
  // block. Superseded by the `session.message` carrying the same `blockId`, which is authoritative.
  // Never persisted (not in conversation history, not in the event log) — a dropped delta costs a
  // moment of preview, nothing more.
  | { type: 'session.message.delta';  ts: string; sessionId: string; channel: string; blockId: string; text: string; seq: number }
  | { type: 'session.status';         ts: string; sessionId: string; channel: string; running: boolean; backgroundRunning?: boolean }
  | { type: 'session.turn';           ts: string; sessionId: string; channel: string; numTurns: number }
  | ({ type: 'session.context-usage'; ts: string; sessionId: string; channel: string } & SessionContextUsage)
  | { type: 'session.context-compacted'; ts: string; sessionId: string; channel: string; status: 'compacted'; contextUsage: SessionContextUsage | null }
  // Mid-turn injection commit: a message injected into a live turn has now been CONSUMED by the
  // model (the backend's replay echo), or its injection window closed without that ever happening.
  // Writing to the backend's stdin only queues it — it may sit there for seconds — so this, not the
  // write, is when it enters conversation history. `messageTs` is the ts the pending
  // `session.message` was published with (the provisional row's key); `committedTs` is the history
  // ts, which is what a transcript refetch returns — clients re-key the row to it so the live row
  // and the fetched row resolve to one.
  | { type: 'session.message.delivered'; ts: string; sessionId: string; channel: string; pendingId: string; messageTs: string; committedTs: string }
  // Message edit + rewind: the session transcript changed shape (turns ≥ turnIndex rolled back).
  // Content-free hint — live clients drop buffered live tails and refetch the transcript.
  | { type: 'session.rewound';        ts: string; sessionId: string; channel: string; turnIndex: number }
  // Sensitive DEBUG data stays in the authoritative transcript query. This content-free hint only
  // asks an open client to refetch after prompt/result sidecars are durably appended.
  | { type: 'session.debug.updated';  ts: string; sessionId: string; channel: string }
  | { type: 'plan.submitted';         ts: string; requestId: string; channel: string; sessionId: string; threadId?: string | null; planContent: string; toolInput: any; dryRun?: boolean; extensionUiId?: string }
  | { type: 'plan.approved';          ts: string; channel: string; executionId: string }
  | { type: 'ask-user.requested';     ts: string; requestId: string; channel: string; sessionId: string; threadId?: string | null; questions: any[]; level?: 'info' | 'warning' | 'error'; dryRun?: boolean; extensionUiId?: string }
  | { type: 'ask-user.answered';      ts: string; channel: string; requestId?: string; sessionId: string; answer: string }
  // Interaction entity state-change notification (web-interactions-redesign): published on
  // creation AND on every status transition. Carries no content payload — clients treat it as
  // a hint and refetch the authoritative transcript ("events as hints, queries as truth").
  | { type: 'session.interaction';    ts: string; sessionId: string; channel: string; interactionId: string; kind: 'ask-user' | 'plan-approval'; status: 'pending' | 'answered' | 'approved' | 'rejected' | 'expired' | 'cancelled' }

  // Agent lifecycle
  | { type: 'agent.started';          ts: string; channel: string; executionId: string; backend: string }
  | { type: 'agent.completed';        ts: string; executionId: string; cost: number; durationMs: number }
  | { type: 'agent.failed';           ts: string; executionId: string; error: string }
  | { type: 'agent.superseded';       ts: string; executionId: string; reason: string }
  | { type: 'execution.log';          ts: string; executionId: string; seq: number; lines: string[]; dropped?: number }

  // Authentication lifecycle
  | { type: 'auth.required';          ts: string; backend: 'claude' | 'pi'; provider: string; authType: 'oauth' | 'api_key' | null; kind: AuthErrorKind; channel: string | null; sessionId: string | null }
  | { type: 'auth.recovered';         ts: string; backend: 'claude' | 'pi'; provider: string }

  // Thread lifecycle
  | { type: 'thread.created';         ts: string; threadId: string; templateName: string }
  | { type: 'thread.step.started';    ts: string; threadId: string; step: string }
  | { type: 'thread.step.finished';   ts: string; threadId: string; step: string; result: string }
  | { type: 'thread.transitioned';    ts: string; threadId: string; from: string; to: string }
  | { type: 'thread.completed';       ts: string; threadId: string }
  | { type: 'thread.failed';          ts: string; threadId: string; error: string }

  // Task
  | { type: 'task.claimed';           ts: string; taskId: string; by: string }
  | { type: 'task.unclaimed';         ts: string; taskId: string }
  | { type: 'task.completed';         ts: string; taskId: string }
  | { type: 'task.dispatched';        ts: string; taskId: string; machine: string }
  | { type: 'task.blocked';           ts: string; taskId: string; reason: string }
  | { type: 'task.unblocked';         ts: string; taskId: string }

  // System
  | { type: 'system.notice';          ts: string; level: 'info' | 'warning' | 'error'; text: string; title?: string }
  | { type: 'config.changed';         ts: string; section: 'profiles' }
  | { type: 'llm.active-count-delta'; ts: string; delta: number }
  | { type: 'scheduler.tick';         ts: string; jobKey: string }
  | { type: 'rate-limit.breach';      ts: string; provider: string; percent: number }
  | { type: 'rate-limit.changed';     ts: string }

    // ── Meta-events (EventBus / EventLogger infrastructure) ───────────────────
  // Audit
  | { type: 'ui.mutate-invoked';        ts: string; op: string; args: unknown; result: { ok: boolean; code?: string } | null }

    // ── Meta-events (EventBus / EventLogger infrastructure) ───────────────────
  | { type: 'event-bus.handler-failed'; ts: string; handlerType: string; error: string }
  | { type: 'event-logger.dropped';     ts: string; droppedSeq: number; droppedType: string };

/**
 * Distributive Omit — correctly removes a key from each union member.
 * Plain `Omit<CortexEvent, 'ts'>` is non-distributive and collapses the union
 * to only shared properties.  Use this when you need per-member omission.
 */
export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

/** Argument type for EventBus.publish — CortexEvent without the injected `ts` field. */
export type CortexEventInput = DistributiveOmit<CortexEvent, 'ts'>;
