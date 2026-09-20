// input:  the server self-update state machine
// output: one manual cross-channel re-check, the moment the server finishes restarting
// pos:    Cross-channel arbitration; owns no channel state and raises no prompt

import { useEffect, useRef } from 'react';
import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import { checkForUpdates } from './manual-update-check';

/**
 * The app shell's update manifest is capped at the server's version, so a new release only becomes
 * visible to the shell once the server is already running it. Re-check the moment the server comes
 * back from `restarting` — without this the shell would not notice for up to 24h and the "one
 * confirmation" promise would quietly become "one confirmation, then wait a day".
 *
 * This lives with the arbitration rather than in `features/server-update`: it watches one channel in
 * order to go and ask the other two, which is the one thing a single channel must not do.
 */
export function useShellRecheckCascade(state: SystemUpdateStatus['state']): void {
  const wasRestarting = useRef(false);
  useEffect(() => {
    if (state === 'restarting') {
      wasRestarting.current = true;
      return;
    }
    if (!wasRestarting.current) return;
    wasRestarting.current = false;
    void checkForUpdates();
  }, [state]);
}
