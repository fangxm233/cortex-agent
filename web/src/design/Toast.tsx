import * as RadixToast from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { addToast, removeToast, type ToastAction, type ToastItem } from './toast-store';
import type { Tone } from './tone';

// Token-styled wrapper over Radix Toast (approved primitive layer, design §1):
// role/announce, swipe-dismiss, timing and hotkey a11y come from Radix. The
// imperative `useToast()` API pushes onto the pure `toast-store` queue; styling
// (tone accent, surface, motion) is token-only. Mount `ToastProvider` once near
// the app root (like `TooltipProvider`).

const TONE_ACCENT: Record<Tone, string> = {
  running: 'border-l-pill-running-fg',
  waiting: 'border-l-pill-waiting-fg',
  done: 'border-l-pill-done-fg',
  failed: 'border-l-pill-failed-fg',
  cancelled: 'border-l-pill-cancelled-fg',
};

const ROOT_CLASS =
  'relative flex flex-col gap-0.5g rounded-card border border-card border-l-4 bg-surface-card p-2g pr-4g shadow-overlay ' +
  'data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out ' +
  'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] ' +
  'data-[swipe=cancel]:translate-x-0 data-[swipe=end]:animate-toast-out ' +
  'motion-reduce:animate-none';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: Tone;
  duration?: number;
  /** Optional action buttons (e.g. the download toast's Open file / Open folder). */
  actions?: ToastAction[];
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setItems((list) => removeToast(list, id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = `toast-${counter.current++}`;
    const item: ToastItem = {
      id,
      title: input.title,
      description: input.description,
      tone: input.tone ?? 'running',
      duration: input.duration ?? 5000,
      actions: input.actions,
    };
    setItems((list) => addToast(list, item));
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {items.map((item) => (
          <RadixToast.Root
            key={item.id}
            duration={item.duration}
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
            className={[ROOT_CLASS, TONE_ACCENT[item.tone]].join(' ')}
          >
            <RadixToast.Title className="text-ui font-medium text-state-ink">
              {item.title}
            </RadixToast.Title>
            {item.description ? (
              <RadixToast.Description className="text-ui text-state-ink/70">
                {item.description}
              </RadixToast.Description>
            ) : null}
            {item.actions && item.actions.length > 0 ? (
              <div className="mt-1g flex flex-wrap gap-1g">
                {item.actions.map((action, i) => (
                  <RadixToast.Action key={i} altText={action.altText ?? action.label} asChild>
                    <button
                      type="button"
                      onClick={action.onClick}
                      className="rounded-card border border-card bg-surface-canvas-alt px-1.5g py-0.5g text-ui text-state-ink transition-colors hover:bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
                    >
                      {action.label}
                    </button>
                  </RadixToast.Action>
                ))}
              </div>
            ) : null}
            <RadixToast.Close
              aria-label="Dismiss"
              className="absolute right-1g top-1g rounded-card p-0.5g text-ui text-state-ink/50 transition-colors hover:bg-surface-canvas-alt hover:text-state-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
            >
              ✕
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed bottom-0 right-0 z-50 m-2g flex w-[24rem] max-w-[calc(100vw-2rem)] flex-col gap-1g outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

/** Provider-optional variant: returns `null` instead of throwing when no `ToastProvider` is in scope.
 *  Lets shared helpers (e.g. useDownloadFile) run inside isolated component tests that render a
 *  consumer bare, without a ToastProvider — they simply skip the toast. */
export function useToastOptional(): ToastContextValue | null {
  return useContext(ToastContext);
}
