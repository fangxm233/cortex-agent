import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isEditableTarget } from '@/features/hot-update/useHotUpdate';
import {
  getAppUpdateSnapshot,
  installAppUpdate,
  publishAppUpdate,
  skipAppUpdate,
  startAppUpdateBridge,
  subscribeAppUpdate,
  type AppUpdateInfo,
} from './app-update';

// Drives the app shell update prompt. Reads the pending update from the module store (fed by the
// shell bridge started here), defers surfacing while a text input is focused (same typing gate as
// the hot-update prompt), and exposes install / skip-this-version / later actions. Off-shell the
// bridge is a no-op, so nothing ever surfaces — the prompt is APP-only.

export interface AppUpdateState {
  /** The update to show, or null (none pending / dismissed this run / typing-gated). */
  update: AppUpdateInfo | null;
  /** True while the install command is in flight. */
  busy: boolean;
  /** Shell-reported install failure, if any. */
  error: string | null;
  /** Install now (per-kind flow — the shell may exit before this settles). */
  install: () => void;
  /** Never offer this version again (persisted shell-side). */
  skip: () => void;
  /** Hide for this run only. */
  dismiss: () => void;
}

export function useAppUpdate(): AppUpdateState {
  const pending = useSyncExternalStore(subscribeAppUpdate, getAppUpdateSnapshot);
  const [shown, setShown] = useState<AppUpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Version dismissed for this run ("稍后") — a ref so the focusout listener reads the latest.
  const dismissedRef = useRef<string | null>(null);

  // Start the shell bridge once (event listener + missed-event backstop).
  useEffect(() => {
    let cancelled = false;
    let unlisten = () => {};
    void startAppUpdateBridge().then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);

  // Surface the pending update, deferring past a focused text field (don't interrupt typing).
  useEffect(() => {
    if (!pending || dismissedRef.current === pending.version) {
      setShown(null);
      return;
    }
    const trySurface = () => {
      if (dismissedRef.current === pending.version) return;
      if (typeof document !== 'undefined' && isEditableTarget(document.activeElement)) return;
      setShown(pending);
    };
    trySurface();
    if (typeof document === 'undefined') return;
    const onFocusOut = () => {
      // Defer a tick so document.activeElement settles after the blur.
      window.setTimeout(trySurface, 0);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, [pending]);

  const install = useCallback(() => {
    setBusy(true);
    setError(null);
    installAppUpdate()
      .then((opened) => {
        setBusy(false);
        // Handoff flows exit the app before resolving; reaching here means an assisted flow opened
        // the installer file (or an older shell no-op'd) — the prompt's job is done for this run.
        if (opened !== null) publishAppUpdate(null);
        setShown(null);
      })
      .catch((e: Error) => {
        setBusy(false);
        setError(e.message);
      });
  }, []);

  const skip = useCallback(() => {
    void skipAppUpdate(); // publishes null into the store
    setShown(null);
  }, []);

  const dismiss = useCallback(() => {
    dismissedRef.current = pending?.version ?? shown?.version ?? null;
    setShown(null);
  }, [pending, shown]);

  return { update: shown, busy, error, install, skip, dismiss };
}
