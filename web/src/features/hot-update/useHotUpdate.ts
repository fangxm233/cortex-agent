import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useUpdateGating } from '@/lib/useUpdateGating';
import { subscribeManualCheckResult } from '@/lib/manual-update-check-result';
import {
  applyFrontendUpdate,
  getStagedUpdate,
  onFrontendUpdateStaged,
  type StagedUpdate,
} from './frontend-update';

export interface HotUpdateState {
  staged: StagedUpdate | null;
  apply: () => void;
  dismiss: () => void;
}

function useHotUpdateSource(dismissed: MutableRefObject<boolean>) {
  const [pending, setPending] = useState<StagedUpdate | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unlisten = () => {};
    const accept = (update: StagedUpdate) => {
      if (!cancelled && !dismissed.current) setPending(update);
    };
    void onFrontendUpdateStaged(accept).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    void getStagedUpdate().then((update) => { if (update) accept(update); });
    const offManual = subscribeManualCheckResult<StagedUpdate>(({ ui }) => {
      if (!ui.update) return;
      dismissed.current = false;
      setPending(ui.update);
    });
    return () => {
      cancelled = true;
      unlisten();
      offManual();
    };
  }, [dismissed]);
  return [pending, setPending] as const;
}

export function useHotUpdate(): HotUpdateState {
  const dismissed = useRef(false);
  const [pending, setPending] = useHotUpdateSource(dismissed);
  const staged = useUpdateGating(pending);
  const apply = useCallback(() => { void applyFrontendUpdate(); }, []);
  const dismiss = useCallback(() => {
    dismissed.current = true;
    setPending(null);
  }, [setPending]);
  return { staged, apply, dismiss };
}
