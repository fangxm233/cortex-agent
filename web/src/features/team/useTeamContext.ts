import { useMemo } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useTeamEnabled } from './useTeamEnabled';
import { teamContext, type TeamContext } from './worker-groups';

/** The open session's lead and workers out of an already-loaded session list; empty with team mode
 *  off. Adds no query of its own. */
export function useTeamContext(active: SessionInfo | null, sessions: SessionInfo[] | undefined): TeamContext {
  const enabled = useTeamEnabled();
  return useMemo(() => teamContext(enabled, active, sessions ?? []), [enabled, active, sessions]);
}
