import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { boardOpenedHeadline } from '@core/board-action.js';
import { webhookAuthHeaders, webSessionId, type CortexToolContext } from './context.js';

const OPEN_DESCRIPTION =
  'Open a board: a live HTML status page shown in the Web UI, worth it when you dispatch several '
  + 'workers or the task spans many turns or hours. Give `title` to create one, or `board` (id or '
  + 'slug) to attach to an existing one. Binds this session, and your active workers that have no '
  + 'board yet if you lead a team. Returns the board directory.';

async function proxyBoard(ctx: CortexToolContext, payload: Record<string, unknown>): Promise<any> {
  const sessionId = webSessionId(ctx);
  if (!sessionId) throw new Error('No web session in context — boards are only available in Web UI sessions');
  const { body } = await requestLoopbackJson(
    'POST', `${ctx.webhookBaseUrl}/webhook/board`, { sessionId, ...payload }, webhookAuthHeaders(ctx),
  );
  if (!body?.success) throw new Error(body?.error || `board ${String(payload.action)} failed`);
  return body.data;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

/** The board_open result text. Its first two lines are read back for the tool row's board action
 *  (see core/board-action.ts). */
export function openedText(data: {
  id: string; title: string; dir: string; created: boolean; bound: string[];
}): string {
  const others = data.bound.length - 1;
  return [
    boardOpenedHeadline(data),
    `Board directory: ${data.dir}`,
    `Edit ${data.dir}/board.html (body content only); put images in ${data.dir}/assets/.`,
    others > 0 ? `Bound this session and ${others} worker(s).` : 'Bound this session.',
    'Write with the preset classes from the board skill; the scaffold has an example of every component.',
  ].join('\n');
}

export function registerUiBoardTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'board_open',
    OPEN_DESCRIPTION,
    {
      title: z.string().optional().describe('Title of a new board.'),
      board: z.string().optional().describe('Id or slug of an existing board.'),
    },
    async ({ title, board }: { title?: string; board?: string }) => {
      try {
        if (!!title?.trim() === !!board?.trim()) throw new Error('give exactly one of title or board');
        const data = await proxyBoard(ctx, { action: 'open', ...(title?.trim() ? { title } : { board }) });
        return textResult(openedText(data));
      } catch (e) {
        return textResult(`board_open failed: ${(e as Error).message}`, true);
      }
    },
  );
}
