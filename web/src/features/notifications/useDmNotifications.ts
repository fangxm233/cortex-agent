import { useLiveEvents } from '@/features/live/LiveEventsProvider';

// Thin glue for turn-scoped DM notifications. Listens on the SHARED live stream
// (`features/live/LiveEventsProvider`) for `session.message` + `session.status`, unscoped (all sessions):
//   · assistant `session.message` events (non-empty) → `onMessage` (the caller buffers the turn's
//     latest per session — see turn-buffer.ts);
//   · `session.status` running:false → `onTurnEnd` (the turn boundary; the caller flushes ONE toast).
// This decoupling is why an agent that emits several assistant messages in a turn produces a single
// toast instead of a burst. All shaping/gating lives outside (NotificationProvider). The live chat
// transcript still consumes `session.message` per message via its own subscription — unaffected.

/** The assistant `session.message` payload we surface as a DM notification. */
export interface DmAssistantMessage {
  sessionId: string;
  channel: string | null;
  text: string;
  ts: string | null;
}

export interface DmNotificationHandlers {
  /** A non-empty assistant message streamed during a turn (buffered by the caller). */
  onMessage: (msg: DmAssistantMessage) => void;
  /** A turn ended for this session (`session.status` running:false) — flush one toast. */
  onTurnEnd: (sessionId: string) => void;
}

const DM_EVENTS = ['session.message', 'session.status'];

/**
 * Receive assistant `session.message` + turn-boundary `session.status` events app-wide.
 * User/tool messages and empty assistant texts are filtered out here.
 */
export function useDmNotifications({ onMessage, onTurnEnd }: DmNotificationHandlers): void {
  useLiveEvents(DM_EVENTS, (raw) => {
    if (raw.type === 'session.message') {
      const p = raw.payload as
        | { sessionId?: string; channel?: string; role?: string; text?: string; ts?: string }
        | undefined;
      if (!p || p.role !== 'assistant') return;
      const text = (p.text ?? '').trim();
      if (!text || !p.sessionId) return;
      onMessage({ sessionId: p.sessionId, channel: p.channel ?? null, text, ts: p.ts ?? null });
      return;
    }
    if (raw.type === 'session.status') {
      const p = raw.payload as { sessionId?: string; running?: boolean } | undefined;
      if (!p || !p.sessionId || p.running !== false) return;
      onTurnEnd(p.sessionId);
    }
  });
}
