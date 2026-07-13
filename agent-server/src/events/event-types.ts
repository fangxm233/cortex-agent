// input:  nothing (leaf module)
// output: CortexEvent union type — all event variants for the EventBus
// pos:    events/ layer, only depends on nothing
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// ── User-facing events (§5.1) ────────────────────────────────────────────────

/** All CortexEvent variants.  `ts` is ISO-8601, injected by EventBus.publish(). */
export type CortexEvent =
  // Message / interaction
  | { type: 'message.received';       ts: string; channel: string; user: string; text: string }
  | { type: 'message.edited';         ts: string; channel: string; user: string; text: string }
  | { type: 'session.message';        ts: string; sessionId: string; channel: string; role: 'user' | 'assistant' | 'tool'; text: string; toolName?: string; toolInput?: string }
  | { type: 'session.status';         ts: string; sessionId: string; channel: string; running: boolean }
  | { type: 'plan.submitted';         ts: string; requestId: string; channel: string; sessionId: string; threadId?: string | null; planContent: string; toolInput: any; dryRun?: boolean; extensionUiId?: string }
  | { type: 'plan.approved';          ts: string; channel: string; executionId: string }
  | { type: 'ask-user.requested';     ts: string; requestId: string; channel: string; sessionId: string; threadId?: string | null; questions: any[]; dryRun?: boolean; extensionUiId?: string }
  | { type: 'ask-user.answered';      ts: string; channel: string; requestId?: string; sessionId: string; answer: string }

  // Agent lifecycle
  | { type: 'agent.started';          ts: string; channel: string; executionId: string; backend: string }
  | { type: 'agent.completed';        ts: string; executionId: string; cost: number; durationMs: number }
  | { type: 'agent.failed';           ts: string; executionId: string; error: string }
  | { type: 'agent.superseded';       ts: string; executionId: string; reason: string }
  | { type: 'execution.log';          ts: string; executionId: string; seq: number; lines: string[]; dropped?: number }

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
  | { type: 'llm.active-count-delta'; ts: string; delta: number }
  | { type: 'scheduler.tick';         ts: string; jobKey: string }
  | { type: 'rate-limit.breach';      ts: string; provider: string; percent: number }

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
