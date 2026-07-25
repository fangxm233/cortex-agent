import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { SYSTEM_LIVE_EVENTS } from '@/features/live/live-events';

// Thin glue: `system.notice` off the SHARED live stream. The server publishes these for admin/system
// broadcasts (startup, restart, profile/config/machine hot-reload, disk, rate-limit) via the
// encapsulated `emitSystemNotice` seam. Unlike DM replies these carry a server-classified level and
// no session, so there is no membership gate — every system.notice surfaces as a toast. All shaping
// (buildSystemNotice) lives in the caller (NotificationProvider). Mirrors useDmNotifications.

/** The `system.notice` event payload we surface as a toast. */
export interface SystemNoticeMessage {
  level: 'info' | 'warning' | 'error';
  text: string;
  title: string | null;
  ts: string | null;
}

/**
 * Receive `system.notice` events app-wide and hand each to `onNotice`. Empty-text events are
 * filtered out here.
 */
export function useSystemNotices(onNotice: (msg: SystemNoticeMessage) => void): void {
  useLiveEvents(SYSTEM_LIVE_EVENTS, (raw) => {
    if (raw.type !== 'system.notice') return;
    const p = raw.payload as
      | { level?: 'info' | 'warning' | 'error'; text?: string; title?: string; ts?: string }
      | undefined;
    const text = (p?.text ?? '').trim();
    if (!text) return;
    onNotice({
      level: p?.level ?? 'info',
      text,
      title: p?.title ?? null,
      ts: p?.ts ?? null,
    });
  });
}
