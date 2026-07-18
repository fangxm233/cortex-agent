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
            aria-label="Cortex"
            style={{
              width: 36,
              height: 36,
              borderRadius: 9,
              background: MC.run,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
            }}
          >
            {/* 25c 皮层弧 C (scheme.dc.html §25c) */}
            <svg width={25} height={25} viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <circle cx={33} cy={32} r={5} fill="#fff" />
              <path d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36" stroke="#fff" strokeWidth={5} strokeLinecap="round" />
              <path d="M48.6 17.95A21 21 0 1 0 48.6 46.05" stroke="#fff" strokeWidth={5} strokeLinecap="round" />
            </svg>
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
