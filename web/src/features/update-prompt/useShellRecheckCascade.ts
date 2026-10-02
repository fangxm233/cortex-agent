import { useEffect, useRef } from 'react';
import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { takeServerUpdateApplied } from '@/lib/manual-update-check-result';
import { checkFrontendUpdates } from './manual-update-check';

/** Consent survives batched renders; reconnect also covers updates started on another device. */
export function useShellRecheckCascade(state: SystemUpdateStatus['state'], hasStatus = true): void {
  const needsRecheck = useRef(false);
  const connection = useConnectionStatus();
  useEffect(() => {
    if (['installing', 'restarting'].includes(state) || ['reconnecting', 'disconnected'].includes(connection)) {
      needsRecheck.current = true;
      return;
    }
    if (state === 'failed') {
      needsRecheck.current = false;
      takeServerUpdateApplied();
      return;
    }
    if (hasStatus && state === 'idle' && (takeServerUpdateApplied() || needsRecheck.current)) {
      needsRecheck.current = false;
      void checkFrontendUpdates();
    }
  }, [state, connection, hasStatus]);
}
