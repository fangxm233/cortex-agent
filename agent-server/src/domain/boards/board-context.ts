import { boardRepo, type BoardStatus } from '@store/board-repo.js';
import { boardDir } from './board-paths.js';

/** What the `[Board]` prompt block names: the board and where its directory is. */
export interface BoardPromptContext {
  id: string;
  title: string;
  dir: string;
}

export interface BoardContextDeps {
  findBoard?: (id: string) => Promise<{ projectId: string; slug: string; title: string; status: BoardStatus } | null>;
  resolveDir?: (projectId: string, slug: string) => string | null;
}

/** The block payload for a session bound to `boardId`, or null when the board is missing or
 *  closed — a closed board is not injected. */
export async function loadBoardPromptContext(
  boardId: string,
  deps: BoardContextDeps = {},
): Promise<BoardPromptContext | null> {
  const board = await (deps.findBoard ?? ((id: string) => boardRepo.find(id)))(boardId);
  if (!board || board.status !== 'active') return null;
  const dir = (deps.resolveDir ?? boardDir)(board.projectId, board.slug);
  return dir ? { id: boardId, title: board.title, dir } : null;
}
