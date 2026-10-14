// `/webhook/board`: the daemon side of the board_open / board_close tools and of the board field
// in cortex_context. The MCP server runs as
// a separate process without the registry, so both tools proxy here.

import { BoardError, boundBoard, closeBoard, defaultBoardServiceDeps, openBoard, type BoardServiceDeps } from '@domain/boards/board-service.js';
import { orchestrationBus } from './runtime.js';

export interface BoardWebhookReply {
  success: boolean;
  data?: unknown;
  error?: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function handleBoardWebhook(
  data: Record<string, any>,
  deps: BoardServiceDeps = defaultBoardServiceDeps((e) => orchestrationBus()?.publish(e)),
): Promise<BoardWebhookReply> {
  const sessionId = str(data.sessionId);
  if (!sessionId) return { success: false, error: 'no session id — board tools need a Web UI session' };
  try {
    if (data.action === 'open') {
      const title = str(data.title);
      const board = str(data.board);
      if (!!title === !!board) return { success: false, error: 'give exactly one of title (new board) or board (existing id or slug)' };
      const result = await openBoard(sessionId, title ? { title } : { board }, deps);
      return {
        success: true,
        data: {
          id: result.board.id, slug: result.board.slug, title: result.board.title, dir: result.dir,
          created: result.created, reopened: result.reopened, bound: result.bound,
        },
      };
    }
    if (data.action === 'close') {
      const status = data.status;
      if (status !== 'done' && status !== 'abandoned') return { success: false, error: 'status must be done or abandoned' };
      const board = await closeBoard(sessionId, { status, note: str(data.note) || undefined }, deps);
      return { success: true, data: { id: board.id, title: board.title, status: board.status } };
    }
    if (data.action === 'status') {
      return { success: true, data: await boundBoard(sessionId, deps) };
    }
    return { success: false, error: `unknown action: ${String(data.action)}` };
  } catch (e) {
    if (e instanceof BoardError) return { success: false, error: e.message };
    throw e;
  }
}
