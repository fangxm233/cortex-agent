import { createContext, useContext, type ReactNode } from 'react';
import type { BoardActionRow } from './board-rows';

// The transcript builds board rows, but drawing them needs the board's live state and the dock,
// which are the board feature's — and that feature already depends on this one. So the chat that
// hosts a stream provides the renderer here, and the stream asks for it (as team-row-slot does).

export interface BoardRowRenderer {
  row: (row: BoardActionRow) => ReactNode;
}

export const BoardRowSlot = createContext<BoardRowRenderer | null>(null);

export function useBoardRowSlot(): BoardRowRenderer | null {
  return useContext(BoardRowSlot);
}
