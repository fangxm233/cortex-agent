// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1q L876-883)
// Presentational top-banner toaster for the mobile 1q notification. Props-driven (the provider binds
// the real notification stream); renders the scheme's floating banner (cx avatar + title + meta + time),
// tappable to activate. Stacks the visible items; reserves the OS status-bar inset at the top.
import { relTimeZh } from '@/mobile/ui/format';
import { MC, MONO } from '@/mobile/ui/kit';
import type { NotificationItem } from '@/features/notifications/notification-vm';

export interface MNotificationToasterProps {
  items: NotificationItem[];
  now?: number;
  onDismiss: (id: string) => void;
  onActivate: (item: NotificationItem) => void;
}

export function MNotificationToaster({ items, now = Date.now(), onDismiss, onActivate }: MNotificationToasterProps) {
  if (items.length === 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(10px + env(safe-area-inset-top))',
        left: 10,
        right: 10,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          role="button"
          onClick={() => onActivate(item)}
          style={{
            pointerEvents: 'auto',
            background: 'rgba(250,250,252,.98)',
            border: '1px solid rgba(0,0,0,.06)',
            borderRadius: 20,
            boxShadow: '0 12px 36px rgba(16,24,40,.24)',
            padding: '11px 13px',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            cursor: 'pointer',
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 9,
              background: MC.ink,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              font: `600 13px ${MONO}`,
              flex: 'none',
            }}
          >
            cx
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 650, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.title}
            </div>
            <div style={{ fontSize: 11, color: MC.sub, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.meta}
            </div>
          </div>
          <span style={{ font: `400 10px ${MONO}`, color: MC.faint, flex: 'none', alignSelf: 'flex-start' }}>
            {relTimeZh(item.ts, now) || '现在'}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(item.id);
            }}
            style={{ border: 'none', background: 'transparent', color: MC.faint, fontSize: 12, cursor: 'pointer', flex: 'none', padding: '0 2px' }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
