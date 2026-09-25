// input:  React, toast store, semantic material and glass tokens
// output: ToastViewport, ToastBubble, useAutoDismiss
// pos:    Material notification overlays and unblurred actions
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useEffect, useRef, useState } from 'react';
import { useToastItems, useToastOptional } from './Toast';
import { relativeAge, splitVisible, type ToastItem, type ToastLevel } from './toast-store';

// The 380px bubble keeps its existing density, semantic icon and 2px progress line. Blur belongs
// to the overlay shell, not the actions. A stationary overlay still samples a changing backdrop.
const SHELL_CLASS =
  '[background:var(--material-overlay-bg)] shadow-[shadow:var(--material-overlay-shadow)] ' +
  '[backdrop-filter:var(--glass-filter)] [-webkit-backdrop-filter:var(--glass-filter)]';

const ICON_TONE: Record<ToastLevel, string> = {
  info: 'bg-proto-accent-bg text-proto-accent',
  success: 'bg-pill-done-bg text-pill-done-fg',
  warning: 'bg-pill-waiting-bg text-pill-waiting-fg',
  error: 'bg-pill-failed-bg text-pill-failed-fg',
};

const ICON_GLYPH: Record<ToastLevel, string> = {
  info: 'i', success: '✓', warning: '!', error: '✕',
};

type BubbleProps = { item: ToastItem; onDismiss: (id: string) => void };

// A real timer owns dismissal, not animationend. Hover pauses the remaining duration; Infinity
// keeps warning/error and progress toasts persistent, including under reduced motion.
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

function ToastHeading({ item, onDismiss }: BubbleProps) {
  return (
    <div className="flex items-baseline gap-[8px]">
      <span className="truncate text-[12.5px] font-semibold text-proto-ink">{item.title}</span>
      <span className="ml-auto flex-none font-mono text-[10px] text-proto-faint">{relativeAge(item.ts)}</span>
      <button type="button" aria-label="Dismiss"
        onClick={(e) => { e.stopPropagation(); onDismiss(item.id); }}
        className="flex-none text-[12px] leading-none text-proto-faint transition-colors hover:text-proto-muted">
        ✕
      </button>
    </div>
  );
}

function ToastActions({ item, onDismiss }: BubbleProps) {
  if (!item.actions?.length) return null;
  return (
    <div className="mt-[8px] flex flex-wrap gap-[6px]">
      {item.actions.map((action, i) => (
        <button key={i} type="button" aria-label={action.altText ?? action.label}
          onClick={(e) => { e.stopPropagation(); action.onClick(); onDismiss(item.id); }}
          className="rounded-[6px] border border-proto-line [background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] px-[8px] py-[3px] text-[10.5px] text-proto-muted transition-colors hover:text-proto-ink">
          {action.label}
        </button>
      ))}
    </div>
  );
}

function ToastBody({ item, onDismiss }: BubbleProps) {
  return (
    <div className="flex items-start gap-[10px]">
      <span className={[
        'flex h-[24px] w-[24px] flex-none items-center justify-center rounded-[var(--r-chip)] text-[11px] font-bold',
        ICON_TONE[item.level],
      ].join(' ')} aria-hidden>{ICON_GLYPH[item.level]}</span>
      <div className="min-w-0 flex-1">
        <ToastHeading item={item} onDismiss={onDismiss} />
        {item.description ? (
          <div className="mt-[3px] line-clamp-2 break-words font-mono text-[10.5px] text-proto-muted-2">
            {item.description}
          </div>
        ) : null}
        <ToastActions item={item} onDismiss={onDismiss} />
      </div>
    </div>
  );
}

function ToastProgress({ duration, paused }: { duration: number; paused: boolean }) {
  if (!Number.isFinite(duration)) return null;
  return <div aria-hidden
    className="absolute bottom-0 left-0 h-[2px] bg-proto-accent opacity-40 animate-toastbar motion-reduce:hidden"
    style={{ animationDuration: `${duration}ms`, animationPlayState: paused ? 'paused' : 'running' }} />;
}

export function ToastBubble({ item, onDismiss }: BubbleProps) {
  const { paused, onMouseEnter, onMouseLeave } = useAutoDismiss(item.id, item.duration, onDismiss);
  const activate = item.onActivate;
  return (
    <div role="status" aria-live={item.level === 'error' ? 'assertive' : 'polite'}
      data-toast-level={item.level} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      onClick={activate ? () => { activate(); onDismiss(item.id); } : undefined}
      className={[
        'relative w-[380px] overflow-hidden rounded-[var(--r-float)]', SHELL_CLASS,
        'px-[13px] pb-[12px] pt-[11px] animate-toast-in motion-reduce:animate-none',
        activate ? 'cursor-pointer' : '',
      ].join(' ')}>
      <ToastBody item={item} onDismiss={onDismiss} />
      <ToastProgress duration={item.duration} paused={paused} />
    </div>
  );
}

function OverflowControl({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button type="button" onClick={onExpand} className={[
      'pointer-events-auto flex items-center gap-[7px] rounded-full px-[12px] py-[5px]', SHELL_CLASS,
    ].join(' ')}>
      <span className="font-mono text-[10.5px] font-semibold text-proto-muted">+{count}</span>
      <span className="text-[11px] text-proto-muted-2">more · click to expand</span>
    </button>
  );
}

// Mount once in the desktop shell: newest three bubbles, older ones folded into a +N pill.
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
      {overflow > 0 && !expanded ? <OverflowControl count={overflow} onExpand={() => setExpanded(true)} /> : null}
    </div>
  );
}
