import type { CortexEvent, EventBus } from '@events/index.js';
import type { UiEvent } from './types.js';

type AssistantDelta = Extract<CortexEvent, { type: 'session.message.delta' }>;
type SessionMessage = Extract<CortexEvent, { type: 'session.message' }>;

/** UI-service-owned, in-memory state for only the unfinished main assistant block per session. */
export class AssistantSnapshots {
  private readonly active = new Map<string, AssistantDelta>();

  constructor(bus: EventBus) {
    const subscriptions = [
      bus.subscribe('session.message.delta', (event) => this.append(event)),
      bus.subscribe('session.message', (event) => this.finalize(event)),
      bus.subscribe('session.status', (event) => {
        if (!event.running) this.active.delete(event.sessionId);
      }),
      bus.subscribe('session.rewound', (event) => { this.active.delete(event.sessionId); }),
    ];
    bus.registerCloseHook(async () => {
      for (const sub of subscriptions) sub.unsubscribe();
      this.active.clear();
    });
  }

  private append(event: AssistantDelta): void {
    const previous = this.active.get(event.sessionId);
    const sameBlock = previous?.blockId === event.blockId;
    if (sameBlock && event.seq <= previous.seq) return;
    const text = sameBlock ? previous.text + event.text : event.text;
    this.active.set(event.sessionId, { ...event, text });
  }

  private finalize(event: SessionMessage): void {
    if (event.role !== 'assistant' || event.noticeLevel || event.subagentId) return;
    const previous = this.active.get(event.sessionId);
    if (!event.blockId || previous?.blockId === event.blockId) this.active.delete(event.sessionId);
  }

  snapshot(sessionId: string): UiEvent {
    const block = this.active.get(sessionId);
    const ts = block?.ts ?? new Date().toISOString();
    // An explicit empty seed clears a partial preview if completion happened during a disconnect.
    // No blockId means no active block; this is a subscription-only payload, never a bus event.
    const payload = block ?? { type: 'session.message.delta', ts, sessionId, text: '' };
    return { type: 'session.message.delta', ts, payload: { ...payload, snapshot: true } };
  }
}
