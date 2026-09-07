// input:  McpServer, daemon UI-view webhook, session tool context
// output: Web-only send_view tool registration
// pos:    Sends agent-authored HTML views into Web chat sessions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { webhookAuthHeaders, webSessionId, type CortexToolContext } from './context.js';

const DESCRIPTION = [
  'Render an HTML view inline in this chat. The user sees it as a live, interactive card in the',
  'conversation — charts, dashboards, comparison tables, small widgets — not as a file to download.',
  '',
  'Use it when the shape of the answer is visual or interactive and prose or a Markdown table would',
  'lose information. Do NOT use it for text that reads fine as Markdown, for a single number, or as',
  'decoration around an answer you already gave.',
  '',
  'Pass either `html` (a self-contained document, up to 256KB) or `file_path` (an .html file you',
  'already wrote, up to 2MB). The document runs in a sandboxed frame with NO access to Cortex, the',
  'page, or any credentials: no parent DOM, no storage, no cookies, no same-origin requests. It may',
  'load libraries and data over https. Inline your CSS and JS; relative paths will not resolve.',
].join('\n');

export function registerUiViewTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'send_view',
    DESCRIPTION,
    {
      title: z.string().describe('Short title shown on the view card, e.g. "Sweep results by seed".'),
      html: z.string().optional().describe('Self-contained HTML document or fragment. Mutually exclusive with file_path.'),
      file_path: z.string().optional().describe('Path to an .html file you already wrote. Mutually exclusive with html.'),
      caption: z.string().optional().describe('Optional one-line note shown above the view.'),
      height: z.number().optional().describe('First-paint height in px (160-900, default 360). The view auto-resizes after load.'),
    },
    async (
      { title, html, file_path, caption, height }:
      { title: string; html?: string; file_path?: string; caption?: string; height?: number },
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
          { sessionId, title, html, filePath: resolved, caption, height },
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
