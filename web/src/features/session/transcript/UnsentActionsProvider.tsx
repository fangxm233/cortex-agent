import type { ReactNode } from 'react';
import { UnsentActionsContext, useUnsentActions } from './useUnsentActions';

/** Gives the open chat's unsent rows their send / edit actions. */
export function UnsentActionsProvider({ sessionId, children }: { sessionId: string | null; children: ReactNode }): JSX.Element {
  const actions = useUnsentActions(sessionId);
  return <UnsentActionsContext.Provider value={actions}>{children}</UnsentActionsContext.Provider>;
}
