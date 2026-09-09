// input:  app-update store, manual results, and typing gate
// output: gated shell updates, install, skip and dismissal actions
// pos:    Shell update source for the shared prompt owner
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useUpdateGating } from '@/features/update/useUpdateGating';
import { subscribeManualCheckResult } from '@/features/update/manual-update-check';
import {
  getAppUpdateSnapshot,
  installAppUpdate,
  publishAppUpdate,
  skipAppUpdate,
  startAppUpdateBridge,
  subscribeAppUpdate,
  type AppUpdateInfo,
} from './app-update';

export interface AppUpdateState {
  pending: AppUpdateInfo | null;
  update: AppUpdateInfo | null;
  busy: boolean;
  error: string | null;
  install: () => void;
  skip: () => void;
  dismiss: () => void;
}

function useAppUpdateBridge(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten = () => {};
    void startAppUpdateBridge().then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);
}

function useAppInstall(version: string | null, hide: (version: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = useCallback(() => {
    setBusy(true);
    setError(null);
    installAppUpdate().then((opened) => {
      setBusy(false);
      hide(version);
      if (opened !== null) publishAppUpdate(null);
    }).catch((reason: Error) => {
      setBusy(false);
      setError(reason.message);
    });
  }, [hide, version]);
  return { busy, error, install };
}

export function useAppUpdate(): AppUpdateState {
  const pending = useSyncExternalStore(subscribeAppUpdate, getAppUpdateSnapshot);
  const [hiddenVersion, setHiddenVersion] = useState<string | null>(null);
  const candidate = pending?.version === hiddenVersion ? null : pending;
  const update = useUpdateGating(candidate);
  const installState = useAppInstall(pending?.version ?? update?.version ?? null, setHiddenVersion);
  useAppUpdateBridge();
  useEffect(() => subscribeManualCheckResult(({ shell }) => {
    if (!shell.update) return;
    setHiddenVersion(null);
    publishAppUpdate(shell.update);
  }), []);

  const skip = useCallback(() => { void skipAppUpdate(); }, []);
  const dismiss = useCallback(() => {
    setHiddenVersion(pending?.version ?? update?.version ?? null);
  }, [pending, update]);
  return { pending, update, ...installState, skip, dismiss };
}
