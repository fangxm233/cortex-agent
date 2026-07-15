// input:  McpServer, daemon webhook (/webhook/ui-file), CORTEX_SESSION_ID / route-context
// output: send_file tool registration (web-only)
// pos:    MCP tool for sending a file to the user in a Web UI chat session. The cortex-web MCP server
//         is layered onto a session ONLY when its channel carries the `web:` prefix, so this tool is
//         invisible to Slack/Feishu/thread sessions. The tool proxies to the daemon webhook (the MCP
//         subprocess has no access to the daemon's conversation history / EventBus), which copies the
//         file into the session workspace, records it on the transcript, and streams the live event.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

export interface UiFileToolDeps {
  /** Route-context file path (Codex writes it; null on Claude, which uses env). */
  routeContextFile: string | null;
}

/** Daemon webhook base — same loopback + token seam the thread/task MCP tools use. */
const WEBHOOK_BASE = `http://127.0.0.1:${process.env.WEBHOOK_PORT || '3001'}`;

/** Resolve the current web session id: prefer the route-context file (Codex), fall back to the
 *  CORTEX_SESSION_ID env the Claude adapter always sets for a session. */
function resolveSessionId(routeContextFile: string | null): string | null {
  if (routeContextFile) {
    try {
      const ctx = JSON.parse(fs.readFileSync(routeContextFile, 'utf8'));
      if (ctx?.sessionId) return String(ctx.sessionId);
      // web channels embed the session id as `web:<sessionId>`.
      if (typeof ctx?.channel === 'string' && ctx.channel.startsWith('web:')) return ctx.channel.slice('web:'.length);
    } catch { /* fall through to env */ }
  }
  const envId = process.env.CORTEX_SESSION_ID;
  if (envId) return envId;
  const ch = process.env.SLACK_CHANNEL || process.env.FEISHU_CHANNEL;
  if (ch && ch.startsWith('web:')) return ch.slice('web:'.length);
  return null;
}

export function registerUiFileTools(server: McpServer, deps: UiFileToolDeps): void {
  server.tool(
    'send_file',
    'Send a file to the user in this chat. Use this whenever you want to share a file you produced — a report, plot, image, dataset, log, PDF, etc. The file appears as a downloadable card in the conversation (images preview inline). Pass a local path to a file you have written or that exists on disk.',
    {
      file_path: z.string().describe('Local path to the file to send (absolute, or relative to the working directory).'),
      file_name: z.string().optional().describe('Optional filename override shown to the user.'),
      caption: z.string().optional().describe('Optional short message shown alongside the file.'),
    },
    async ({ file_path, file_name, caption }: { file_path: string; file_name?: string; caption?: string }) => {
      try {
        const sessionId = resolveSessionId(deps.routeContextFile);
        if (!sessionId) throw new Error('No web session in context — send_file is only usable inside a Web UI chat session');

        const resolved = path.isAbsolute(file_path) ? file_path : path.resolve(process.cwd(), file_path);
        if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
        if (!fs.statSync(resolved).isFile()) throw new Error(`Not a file: ${resolved}`);

        const res = await fetch(`${WEBHOOK_BASE}/webhook/ui-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '' },
          body: JSON.stringify({ sessionId, filePath: resolved, fileName: file_name, caption }),
        });
        const data = await res.json() as any;
        if (!data.success) throw new Error(data.error || 'send_file failed');
        const meta = data.data;
        return { content: [{ type: 'text', text: `Sent file to the user: ${meta.name} (${meta.size} bytes)` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to send file: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
