import { createContext, useContext, type ReactNode } from 'react';
import type { TeamChatRow } from './team-rows';

// The transcript builds team rows, but drawing them needs the live team (each worker's status dot,
// opening its session), which is the team feature's to know — and that feature already depends on
// this one. So the chat that hosts a stream provides the renderer here, and the stream asks for it.

export interface TeamRowRenderer {
  /** One team-action or team-updates row. */
  row: (row: TeamChatRow) => ReactNode;
  /** What follows the last row: the lead's quiet "waiting on its workers" line, or nothing. */
  tail: ReactNode;
}

export const TeamRowSlot = createContext<TeamRowRenderer | null>(null);

export function useTeamRowSlot(): TeamRowRenderer | null {
  return useContext(TeamRowSlot);
}
