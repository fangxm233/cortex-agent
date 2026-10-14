import { t } from '@core/i18n.js';
import { boardRepo, type BoardStatus } from '@store/board-repo.js';
import type { UiServiceDeps, Result, BoardInfo, MutateArgs } from '../types.js';
import { toBoardInfo } from '../query/boards.js';

/** Close a board as done/abandoned from the board view. The board directory is left untouched;
 *  a session opening it again with board_open reactivates it. */
export async function handleBoardClose(
  deps: UiServiceDeps,
  args: MutateArgs<'boards.close'>,
): Promise<Result<BoardInfo>> {
  const store = deps.boardStore ?? boardRepo;
  // Checked inside the update, under the repo lock, so two racing closes cannot both win.
  let closedAs: BoardStatus | null = null;
  const updated = await store.update(args.boardId, (r) => {
    if (r.status !== 'active') {
      closedAs = r.status;
      return false;
    }
    r.status = args.status;
    r.closedAt = Date.now();
    if (args.note) r.closeNote = args.note;
  });
  if (!updated) {
    return { ok: false, code: 'not-found', message: t('ui.board.notFound', { id: args.boardId }) };
  }
  if (closedAs) {
    return { ok: false, code: 'already-terminal', message: t('ui.board.alreadyClosed', { status: closedAs }) };
  }
  deps.bus.publish({ type: 'board.updated', boardId: updated.id, projectId: updated.projectId });
  return { ok: true, data: toBoardInfo(updated) };
}
