// input:  McpServer, daemon UI-file webhook, CORTEX_SESSION_ID
// output: Web-only send_file tool registration
// pos:    Sends agent-produced files into Web chat sessions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

/** Daemon webhook base — same loopback + token seam the thread/task MCP tools use. */
const WEBHOOK_BASE = `http://127.0.0.1:${process.env.WEBHOOK_PORT || '3001'}`;

function resolveSessionId(): string | null {
  const envId = process.env.CORTEX_SESSION_ID;
  if (envId) return envId;
  const ch = process.env.SLACK_CHANNEL || process.env.FEISHU_CHANNEL;
  if (ch && ch.startsWith('web:')) return ch.slice('web:'.length);
  return null;
}

export function registerUiFileTools(server: McpServer): void {
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
        const sessionId = resolveSessionId();
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
