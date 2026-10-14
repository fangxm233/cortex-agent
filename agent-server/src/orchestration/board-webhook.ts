// `/webhook/board`: the daemon side of the board_open tool and of the board field in
// cortex_context. The MCP server runs as a separate process without the registry, so both proxy
// here.

import { BoardError, boundBoard, defaultBoardServiceDeps, openBoard, type BoardServiceDeps } from '@domain/boards/board-service.js';
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
          created: result.created, bound: result.bound,
        },
      };
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
