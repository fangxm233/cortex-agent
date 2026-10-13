import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { webhookAuthHeaders, webSessionId, type CortexToolContext } from './context.js';

const DESCRIPTION =
  'Render an interactive HTML card, not a download. Use when visuals convey more than Markdown; '
  + 'not for plain text, single numbers, or decoration. Sandboxed: no Cortex, parent DOM, credentials, '
  + 'storage, cookies, or same-origin requests. HTTPS resources allowed. Inline CSS/JS; relative paths fail.';

export function registerUiViewTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'send_view',
    DESCRIPTION,
    {
      title: z.string().describe('Short card title.'),
      html: z.string().optional().describe('Self-contained HTML, max 256KB. Use html OR file_path.'),
      file_path: z.string().optional().describe('Existing .html file, max 2MB. Use file_path OR html.'),
      caption: z.string().optional().describe('Optional one-line note shown above the view.'),
      height: z.number().optional().describe('First-paint height in px (160-900, default 360). The view auto-resizes after load.'),
      width: z.enum(['narrow', 'wide', 'full']).optional().describe(
        'Card width: narrow (default, text column), wide (~1.5x), or full chat pane.',
      ),
    },
    async (
      { title, html, file_path, caption, height, width }:
      { title: string; html?: string; file_path?: string; caption?: string; height?: number; width?: 'narrow' | 'wide' | 'full' },
    ) => {
      try {
        const sessionId = webSessionId(ctx);
        if (!sessionId) throw new Error('No web session in context — send_view is only usable inside a Web UI chat session');

        const hasHtml = typeof html === 'string' && html.length > 0;
        const hasPath = typeof file_path === 'string' && file_path.length > 0;
        if (hasHtml === hasPath) throw new Error('Provide exactly one of `html` or `file_path`');

        let resolved: string | undefined;
        if (hasPath) {
          resolved = path.isAbsolute(file_path!) ? file_path! : path.resolve(process.cwd(), file_path!);
          if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
          if (!fs.statSync(resolved).isFile()) throw new Error(`Not a file: ${resolved}`);
        }

        const { body } = await requestLoopbackJson(
          'POST',
          `${ctx.webhookBaseUrl}/webhook/ui-view`,
          { sessionId, title, html, filePath: resolved, caption, height, width },
          webhookAuthHeaders(ctx),
        );
        if (!body.success) throw new Error(body.error || 'send_view failed');
        const meta = body.data;
        return { content: [{ type: 'text', text: `Rendered view in the chat: ${meta.name} (${meta.size} bytes)` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to send view: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
