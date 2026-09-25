// input:  Shared toast queue, mobile palette, relative time
// output: MNotificationToaster, MNotificationBanners
// pos:    Low-cost mobile notification material banners
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { relTimeZh } from '@/mobile/ui/format';
import { MC, MONO } from '@/mobile/ui/kit';
import { splitVisible, useToast, useToastItems, useAutoDismiss, type ToastItem } from '@/design';

export interface MNotificationToasterProps {
  items: ToastItem[];
  now?: number;
  onDismiss: (id: string) => void;
}

/** Mobile rendering of the app's shared bubble queue: the scheme 1q top banner. Same items as the
 *  desktop `ToastViewport` (chat replies, system notices AND action feedback) — mobile no longer
 *  inherits the desktop bottom-right stack over its Tab bar. */
export function MNotificationToaster({ items, now = Date.now(), onDismiss }: MNotificationToasterProps) {
  if (items.length === 0) return null;
  const { visible } = splitVisible(items);
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
      {visible.map((item) => (
        <MBanner key={item.id} item={item} now={now} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function MBanner({ item, now, onDismiss }: { item: ToastItem; now: number; onDismiss: (id: string) => void }) {
  const { onMouseEnter, onMouseLeave } = useAutoDismiss(item.id, item.duration, onDismiss);
  const activate = item.onActivate;
  return (
    <div
      role={activate ? 'button' : 'status'}
      onTouchStart={onMouseEnter}
      onTouchEnd={onMouseLeave}
      onClick={activate ? () => { activate(); onDismiss(item.id); } : undefined}
      style={{
        pointerEvents: 'auto',
        // Dense overlay fill without a per-notification backdrop sample.
        background: 'var(--material-overlay-bg)',
        border: '1px solid var(--panel-translucent-border)',
        borderRadius: 'var(--r-float)',
        boxShadow: 'var(--material-overlay-shadow)',
        padding: '11px 13px',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        cursor: activate ? 'pointer' : 'default',
      }}
    >
      <div
        aria-label="Cortex"
        style={{
          width: 36,
          height: 36,
          borderRadius: 'var(--r-chip)',
          background: 'var(--brand-badge-bg)',
          border: '1px solid var(--brand-badge-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        {/* 25c 皮层弧 C (scheme.dc.html §25c) — follows theme */}
        <svg width={25} height={25} viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <circle cx={33} cy={32} r={5} fill="var(--brand-badge-core)" />
          <path d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36" stroke="var(--brand-badge-arc)" strokeWidth={5} strokeLinecap="round" />
          <path d="M48.6 17.95A21 21 0 1 0 48.6 46.05" stroke="var(--brand-badge-arc)" strokeWidth={5} strokeLinecap="round" />
        </svg>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 650, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.title}
        </div>
        {item.description ? (
          <div style={{ fontSize: 11, color: MC.sub, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.description}
          </div>
        ) : null}
        {item.actions?.length ? (
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {item.actions.map((action, i) => (
              <button
                key={i}
                type="button"
                aria-label={action.altText ?? action.label}
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick();
                  onDismiss(item.id);
                }}
                style={{
                  border: '1px solid var(--panel-translucent-border)', borderRadius: 'var(--r-chip)',
                  background: 'transparent', color: MC.ink, fontSize: 11, padding: '3px 8px',
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
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
  );
}

/** Mounts the mobile stack from the shared queue. */
export function MNotificationBanners({ now }: { now?: number }) {
  const { dismiss } = useToast();
  const items = useToastItems();
  return <MNotificationToaster items={items} now={now} onDismiss={dismiss} />;
}
