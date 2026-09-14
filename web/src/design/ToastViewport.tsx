import { useEffect, useRef, useState } from 'react';
import { useToastItems, useToastOptional } from './Toast';
import { relativeAge, splitVisible, type ToastItem, type ToastLevel } from './toast-store';

// The desktop bubble stack — a 1:1 build of scheme.dc.html section 18a (系统通知 toast), now the ONE
// renderer for every on-screen bubble (action feedback and the live notification feed alike):
//   · 380px 卡片, 圆角 11, proto-line 描边, 二级投影 (shadow-toast). 泡泡本体不上色、无左侧色条.
//   · 24px 圆角方块 icon 承载级别色 (info=run 蓝 · success=绿 · warning=琥珀 · error=红, token 淡底).
//   · 标题 12.5/600 ink · 正文一行 Plex Mono 10.5 灰 (最多两行) · 有 onActivate 时点击主体跳转.
//   · 底部 2px 进度线 = 自动消失倒计时; 常驻 (duration=Infinity) 的不画线.
//   · 右下角 (距边 16px), 向上堆叠最多 3 条, 溢出折叠为「+N」胶囊.
// Token-only (no hard-coded hex); one-off px dimensions stay raw per design §8.3.
//
// Dismissal is owned by a real JS timer (useAutoDismiss), not by the progress bar's animationend —
// the old CSS-only scheme never fired under `prefers-reduced-motion` or in jsdom, so bubbles could
// linger forever. The bar is now decoration synced to the item's duration.

const ICON_TONE: Record<ToastLevel, string> = {
  info: 'bg-proto-accent-bg text-proto-accent', // run blue tint
  success: 'bg-pill-done-bg text-pill-done-fg', // green tint
  warning: 'bg-pill-waiting-bg text-pill-waiting-fg', // amber tint
  error: 'bg-pill-failed-bg text-pill-failed-fg', // red tint
};

const ICON_GLYPH: Record<ToastLevel, string> = {
  info: 'i',
  success: '✓',
  warning: '!',
  error: '✕',
};

/**
 * Auto-dismiss timer for one bubble. Returns hover handlers that pause it (so a user reaching for
 * an action button never loses the bubble mid-click) and the paused flag for the progress bar.
 * `Infinity` (warning/error, the update-check progress toast) means no timer at all.
 */
export function useAutoDismiss(id: string, duration: number, onDismiss: (id: string) => void) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(() => dismissRef.current(id), Math.max(0, remaining.current));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [id, paused]);

  return {
    paused,
    onMouseEnter: () => setPaused(true),
    onMouseLeave: () => setPaused(false),
  };
}

export function ToastBubble({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const { paused, onMouseEnter, onMouseLeave } = useAutoDismiss(item.id, item.duration, onDismiss);
  const activate = item.onActivate;
  return (
    <div
      role="status"
      aria-live={item.level === 'error' ? 'assertive' : 'polite'}
      data-toast-level={item.level}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={activate ? () => { activate(); onDismiss(item.id); } : undefined}
      className={[
        'relative w-[380px] overflow-hidden rounded-[11px] border border-proto-line bg-surface-card',
        'px-[13px] pb-[12px] pt-[11px] shadow-toast animate-toast-in motion-reduce:animate-none',
        activate ? 'cursor-pointer' : '',
      ].join(' ')}
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
            <span className="truncate text-[12.5px] font-semibold text-proto-ink">{item.title}</span>
            <span className="ml-auto flex-none font-mono text-[10px] text-proto-faint">{relativeAge(item.ts)}</span>
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
          {item.description ? (
            <div className="mt-[3px] line-clamp-2 break-words font-mono text-[10.5px] text-proto-muted-2">
              {item.description}
            </div>
          ) : null}
          {item.actions?.length ? (
            <div className="mt-[8px] flex flex-wrap gap-[6px]">
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
                  className="rounded-[6px] border border-proto-line bg-proto-card px-[8px] py-[3px] text-[10.5px] text-proto-muted transition-colors hover:text-proto-ink"
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {Number.isFinite(item.duration) ? (
        <div
          aria-hidden
          className="absolute bottom-0 left-0 h-[2px] bg-proto-accent opacity-40 animate-toastbar motion-reduce:hidden"
          style={{ animationDuration: `${item.duration}ms`, animationPlayState: paused ? 'paused' : 'running' }}
        />
      ) : null}
    </div>
  );
}

/** The bottom-right stack: newest 3 (向上堆叠), older ones folded into a "+N" pill that expands on
 *  click. Mount once per desktop shell; reads the shared queue from ToastProvider. */
export function ToastViewport() {
  const ctx = useToastOptional();
  const items = useToastItems();
  const [expanded, setExpanded] = useState(false);
  if (!ctx || items.length === 0) return null;
  const { dismiss } = ctx;

  const { visible, overflow } = splitVisible(items);
  const shown = expanded ? items : visible;

  return (
    <div className="pointer-events-none fixed bottom-0 right-0 z-50 m-2g flex w-[380px] max-w-[calc(100vw-2rem)] flex-col items-end gap-[10px]">
      {shown.map((item) => (
        <div key={item.id} className="pointer-events-auto w-full">
          <ToastBubble item={item} onDismiss={dismiss} />
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
