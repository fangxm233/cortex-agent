// input:  staged-update bridge events, backstop query, and shared typing gate
// output: gated frontend-update state with apply and run-local dismissal actions
// pos:    Headless hot-update source consumed only by the shared update prompt owner
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useUpdateGating } from '@/features/update/useUpdateGating';
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

function useHotUpdateSource(dismissed: RefObject<boolean>) {
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
    return () => {
      cancelled = true;
      unlisten();
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
