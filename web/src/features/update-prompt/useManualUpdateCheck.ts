// input:  manual check controller, vocabulary and toast provider
// output: busy menu action with progress and per-channel results
// pos:    Menu feedback lifecycle; existing owner handles prompts
// >>> If updated, update this header and parent CORTEX.md <<<

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useToastOptional } from '@/design/Toast';
import { useVocab } from '@/i18n';
import { checkForUpdates, getManualCheckBusy, subscribeManualCheck } from './manual-update-check';
import { updateCheckFeedback } from './update-check-feedback';

export function useManualUpdateCheck() {
  const L = useVocab();
  const toast = useToastOptional();
  const busy = useSyncExternalStore(subscribeManualCheck, getManualCheckBusy);
  const mounted = useRef(false);
  const progress = useRef<string>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (progress.current) toast?.dismiss(progress.current);
    };
  }, [toast]);
  const check = useCallback(async () => {
    if (getManualCheckBusy()) return;
    progress.current = toast?.toast({ title: L.updateCheckBusy, description: L.updateCheckProgress,
      tone: 'running', duration: Infinity });
    const report = await checkForUpdates();
    if (!mounted.current) return;
    if (progress.current) toast?.dismiss(progress.current);
    progress.current = undefined;
    updateCheckFeedback(report, L).forEach((feedback) => toast?.toast(feedback));
  }, [L, toast]);
  return { busy, check };
}
