import { useSyncExternalStore } from 'react';

// The app's replacement for window.confirm / window.prompt: a call returns a promise and one host
// per shell (DialogHost on desktop, MDialogHost on mobile) renders the request in the app's own
// dialog chrome. Requests queue, so a second ask waits for the first instead of replacing it.
// The store is module-level so non-component code (the mobile system-back handler) can dismiss.

export type DialogTone = 'default' | 'danger';

export interface ConfirmDialogOptions {
  title: string;
  description?: string;
  confirmLabel: string;
  /** Defaults to the shared Cancel label. */
  cancelLabel?: string;
  tone?: DialogTone;
}

export interface PromptDialogOptions extends ConfirmDialogOptions {
  /** Accessible name and placeholder of the text field. */
  inputLabel: string;
  initialValue?: string;
}

export interface DialogRequest extends ConfirmDialogOptions {
  id: number;
  input?: { label: string; initialValue: string };
}

interface Pending {
  request: DialogRequest;
  settle: (value: string | null) => void;
}

let queue: Pending[] = [];
let lastShown: DialogRequest | undefined;
// What had focus before the first request opened; the dialog has no trigger for Radix to return to.
let returnFocus: HTMLElement | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  if (queue[0]) lastShown = queue[0].request;
  for (const listener of [...listeners]) listener();
}

function enqueue(request: Omit<DialogRequest, 'id'>): Promise<string | null> {
  return new Promise((settle) => {
    if (queue.length === 0 && typeof document !== 'undefined') {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    queue = [...queue, { request: { ...request, id: nextId++ }, settle }];
    emit();
  });
}

/** Resolves true when the user confirms; false on cancel, Escape, outside click or system back. */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return enqueue(options).then((value) => value !== null);
}

/** Resolves the trimmed text, or null when the user cancels or submits nothing. */
export function promptDialog({ inputLabel, initialValue = '', ...options }: PromptDialogOptions): Promise<string | null> {
  return enqueue({ ...options, input: { label: inputLabel, initialValue } })
    .then((value) => value?.trim() || null);
}

/** Answer the request `id`: a string confirms (the prompt text, '' for a confirm), null cancels. */
export function settleDialog(id: number, value: string | null): void {
  const head = queue[0];
  if (!head || head.request.id !== id) return;
  queue = queue.slice(1);
  emit();
  head.settle(value);
}

/** Cancel the visible request; false when nothing is open. */
export function dismissDialog(): boolean {
  const head = queue[0];
  if (!head) return false;
  settleDialog(head.request.id, null);
  return true;
}

/** Radix close-focus handler: hand focus back to where it was before the dialog opened. */
export function restoreDialogFocus(event: Event): void {
  event.preventDefault();
  const target = returnFocus;
  returnFocus = null;
  if (target?.isConnected) target.focus();
}

export function currentDialog(): DialogRequest | undefined {
  return queue[0]?.request;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function lastDialog(): DialogRequest | undefined {
  return lastShown;
}

export function useCurrentDialog(): DialogRequest | undefined {
  return useSyncExternalStore(subscribe, currentDialog, currentDialog);
}

/** The open request, plus the one just answered so its dialog can animate out with its content. */
export function useDialogPresentation(): { current: DialogRequest | undefined; shown: DialogRequest | undefined } {
  const current = useCurrentDialog();
  const shown = useSyncExternalStore(subscribe, lastDialog, lastDialog);
  return { current, shown: current ?? shown };
}
