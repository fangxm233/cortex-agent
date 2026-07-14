import { useState } from 'react';
import type { NotificationItem, NotificationLevel } from './notification-vm';
import { isTransient } from './notification-vm';
import { splitVisible } from './notification-store';

// Presentational notification toaster — a 1:1 build of scheme.dc.html section 18a (系统通知 toast):
//   · 380px 白底泡泡, 圆角 11, proto-line 描边, 二级投影 (shadow-toast). 泡泡本体不上色、无左侧色条.
//   · 24px 圆角方块 icon 承载级别色 (info=run 蓝 · warning=琥珀 · error=红, token 淡底).
//   · 标题 12.5/600 ink · 元数据一行 Plex Mono 10.5 灰 nowrap ellipsis · 点击泡泡主体跳转.
//   · 底部 2px 进度线 = 自动消失倒计时 (仅 info); warning/error 常驻无此线.
//   · 右下角 (距边 16px), 向上堆叠最多 3 条, 溢出折叠为「+N」胶囊.
// Token-only (no hard-coded hex); one-off px dimensions stay raw per design §8.3.

// icon 淡底/前景 — 沿用 pill / proto token 色板, 一一对应 scheme 18a 的三级级别色.
const ICON_TONE: Record<NotificationLevel, string> = {
  info: 'bg-proto-accent-bg text-proto-accent', // run blue tint
  warning: 'bg-pill-waiting-bg text-pill-waiting-fg', // amber tint
  error: 'bg-pill-failed-bg text-pill-failed-fg', // red tint
};

const ICON_GLYPH: Record<NotificationLevel, string> = {
  info: 'i',
  warning: '!',
  error: '✕',
};

/** Compact relative age ("now" / "2m" / "1h") for the mono time slot (scheme 18a). */
export function relativeAge(ts: string, now: number = Date.now()): string {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return 'now';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function NotificationBubble({
  item,
  onDismiss,
  onActivate,
}: {
  item: NotificationItem;
  onDismiss: (id: string) => void;
  onActivate: (item: NotificationItem) => void;
}) {
  const transient = isTransient(item.level);
  return (
    <div
      role="status"
      onClick={() => onActivate(item)}
      className="group relative w-[380px] cursor-pointer overflow-hidden rounded-[11px] border border-proto-line bg-surface-card px-[13px] pb-[12px] pt-[11px] shadow-toast animate-toast-in motion-reduce:animate-none"
    >
      <div className="flex items-start gap-[10px]">
        <span
          className={[
            'flex h-[24px] w-[24px] flex-none items-center justify-center rounded-[7px] text-[11px] font-bold',
            ICON_TONE[item.level],
          ].join(' ')}
          aria-hidden
        >
          {ICON_GLYPH[item.level]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-[8px]">
            <span className="text-[12.5px] font-semibold text-proto-ink">{item.title}</span>
            <span className="ml-auto font-mono text-[10px] text-proto-faint">{relativeAge(item.ts)}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(item.id);
              }}
              className="flex-none text-[12px] leading-none text-proto-faint transition-colors hover:text-proto-muted"
            >
              ✕
            </button>
          </div>
          <div className="mt-[3px] truncate font-mono text-[10.5px] text-proto-muted-2">{item.meta}</div>
        </div>
      </div>
      {transient ? (
        <div
          className="absolute bottom-0 left-0 h-[2px] bg-proto-accent opacity-40 animate-toastbar group-hover:[animation-play-state:paused]"
          onAnimationEnd={(e) => {
            if (e.animationName === 'toastbar') onDismiss(item.id);
          }}
        />
      ) : null}
    </div>
  );
}

export interface NotificationToasterProps {
  items: NotificationItem[];
  onDismiss: (id: string) => void;
  onActivate: (item: NotificationItem) => void;
}

/** The bottom-right stack. Shows the newest 3 (向上堆叠); older ones fold into a "+N" pill that
 *  expands on click. Pure over its props — the provider owns the queue + subscription glue. */
export function NotificationToaster({ items, onDismiss, onActivate }: NotificationToasterProps) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const { visible, overflow } = splitVisible(items);
  const shown = expanded ? items : visible;

  return (
    <div className="pointer-events-none fixed bottom-0 right-0 z-50 m-2g flex w-[380px] max-w-[calc(100vw-2rem)] flex-col items-end gap-[10px]">
      {shown.map((item) => (
        <div key={item.id} className="pointer-events-auto w-full">
          <NotificationBubble item={item} onDismiss={onDismiss} onActivate={onActivate} />
        </div>
      ))}
      {overflow > 0 && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="pointer-events-auto flex items-center gap-[7px] rounded-full border border-proto-line bg-surface-card px-[12px] py-[5px] shadow-toast-pill"
        >
          <span className="font-mono text-[10.5px] font-semibold text-proto-muted">+{overflow}</span>
          <span className="text-[11px] text-proto-muted-2">more · click to expand</span>
        </button>
      ) : null}
    </div>
  );
}
