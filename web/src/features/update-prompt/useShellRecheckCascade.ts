import { useEffect, useRef } from 'react';
import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import { checkFrontendUpdates } from './manual-update-check';

/** Recheck shell/UI (or browser assets) after installation reconnects. Polling can miss the
 * restarting state entirely, so installing → idle is also a completion signal. */
export function useShellRecheckCascade(state: SystemUpdateStatus['state']): void {
  const wasUpdating = useRef(false);
  useEffect(() => {
    if (state === 'installing' || state === 'restarting') {
      wasUpdating.current = true;
      return;
    }
    if (!wasUpdating.current) return;
    wasUpdating.current = false;
    if (state === 'idle') void checkFrontendUpdates();
  }, [state]);
}
