import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { isAbsoluteFilePath } from './remote-file.js';
import { webhookAuthHeaders, webSessionId, type CortexToolContext } from './context.js';

export function registerUiFileTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'send_file',
    'Send a file to the user in this chat. Use this whenever you want to share a file you produced — a report, plot, image, dataset, log, PDF, etc. The file appears as a downloadable card in the conversation (images preview inline). Pass a local path to a file you have written or that exists on disk, or set `device` to send a file that lives on a remote device instead.',
    {
      file_path: z.string().describe('Path to the file to send. Local path (absolute, or relative to the working directory); with `device`, an absolute path on that device.'),
      file_name: z.string().optional().describe('Optional filename override shown to the user.'),
      caption: z.string().optional().describe('Optional short message shown alongside the file.'),
      device: z.string().optional().describe('Name of a connected remote device (as used by remote_bash). The file is read there and streamed back. Omit for files on this server.'),
    },
    async ({ file_path, file_name, caption, device }: {
      file_path: string; file_name?: string; caption?: string; device?: string;
    }) => {
      try {
        const sessionId = webSessionId(ctx);
        if (!sessionId) throw new Error('No web session in context — send_file is only usable inside a Web UI chat session');

        // With `device` the path belongs to another machine: it cannot be resolved or stat'ed here,
        // and a relative path would be meaningless there. The daemon validates it on the device.
        let resolved: string;
        if (device) {
          if (!isAbsoluteFilePath(file_path)) throw new Error('file_path must be absolute when `device` is set');
          resolved = file_path;
        } else {
          resolved = path.isAbsolute(file_path) ? file_path : path.resolve(process.cwd(), file_path);
          if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
          if (!fs.statSync(resolved).isFile()) throw new Error(`Not a file: ${resolved}`);
        }

        const { body } = await requestLoopbackJson(
          'POST',
          `${ctx.webhookBaseUrl}/webhook/ui-file`,
          { sessionId, filePath: resolved, fileName: file_name, caption, device },
          webhookAuthHeaders(ctx),
        );
        if (!body.success) throw new Error(body.error || 'send_file failed');
        const meta = body.data;
        const from = device ? ` from ${device}` : '';
        return { content: [{ type: 'text', text: `Sent file to the user${from}: ${meta.name} (${meta.size} bytes)` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to send file: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
