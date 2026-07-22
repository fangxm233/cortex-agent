import type { Tone } from './tone';

// Pure toast-queue logic (design §5, task 970d). Framework-agnostic and
// deterministic so it can be unit-tested without a DOM; the React `useToast`
// hook in Toast.tsx owns id generation and timers and delegates to these.

export const MAX_TOASTS = 4;

/** An optional action button rendered inside a toast (e.g. the download toast's "Open file" /
 *  "Open folder"). Clicking it runs `onClick` and dismisses the toast (Radix Toast.Action behaviour). */
export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Screen-reader alternative for the action (Radix requires it); defaults to `label`. */
  altText?: string;
}

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone: Tone;
  duration: number;
  actions?: ToastAction[];
}

// Append `item`; if that exceeds `max`, drop the oldest so the newest stays visible.
export function addToast(list: ToastItem[], item: ToastItem, max = MAX_TOASTS): ToastItem[] {
  const next = [...list, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function removeToast(list: ToastItem[], id: string): ToastItem[] {
  return list.filter((t) => t.id !== id);
}
