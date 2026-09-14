import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { addToast, removeToast, TONE_LEVEL, type ToastAction, type ToastItem, type ToastLevel } from './toast-store';
import type { Tone } from './tone';

// The app's single bubble queue. `ToastProvider` owns the state (mount it once near the app root,
// like `TooltipProvider`); the renderers are separate so each shell can place the stack where it
// belongs — `ToastViewport` (desktop, bottom-right, scheme 18a) and `MNotificationToaster`
// (mobile, top banner). Nothing is rendered here.
//
// Two producers share the queue: imperative `useToast()` calls (action feedback) and the live
// notification feed (features/notifications), which passes the richer optional fields
// (`level`, `ts`, `onActivate`, `dedupeKey`). Keeping one queue is what stops the two stacks from
// overlapping in the same corner, which is what they used to do.

/** Default lifetime of an action toast. Feed items pass their own (info 6s, warning/error resident). */
export const DEFAULT_TOAST_MS = 5000;

export interface ToastInput {
  title: string;
  description?: string;
  /** Status vocabulary used by call sites; mapped to a `level` unless `level` is given. */
  tone?: Tone;
  /** Explicit severity — wins over `tone`. Used by the server-classified notification feed. */
  level?: ToastLevel;
  /** Milliseconds; `Infinity` keeps the bubble until it is dismissed. */
  duration?: number;
  /** Optional action buttons (e.g. the download toast's Open file / Open folder). */
  actions?: ToastAction[];
  /** ISO-8601 event time for the age slot; defaults to now. */
  ts?: string;
  /** Click-through on the bubble body (feed items open their session). */
  onActivate?: () => void;
  /** Consecutive-duplicate key (see toast-store.addToast). */
  dedupeKey?: string;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

// Two contexts on purpose: the imperative API is stable for the lifetime of the provider, so the
// ~20 components that only ever call `toast()` never re-render when the queue changes. Only the
// renderers subscribe to the queue itself.
const ToastContext = createContext<ToastContextValue | null>(null);
const ToastItemsContext = createContext<ToastItem[]>([]);

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
      level: input.level ?? TONE_LEVEL[input.tone ?? 'running'],
      title: input.title,
      description: input.description,
      ts: input.ts ?? new Date().toISOString(),
      duration: input.duration ?? DEFAULT_TOAST_MS,
      actions: input.actions,
      onActivate: input.onActivate,
      dedupeKey: input.dedupeKey,
    };
    setItems((list) => addToast(list, item));
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <ToastItemsContext.Provider value={items}>{children}</ToastItemsContext.Provider>
    </ToastContext.Provider>
  );
}

/** The live queue, newest last — for the shells' renderers. Empty outside a provider. */
export function useToastItems(): ToastItem[] {
  return useContext(ToastItemsContext);
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
