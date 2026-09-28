import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { isAbsoluteFilePath } from './remote-file.js';
import { webhookAuthHeaders, webSessionId, type CortexToolContext } from './context.js';

interface FileSpec { file_path: string; file_name?: string }
interface SendFileInput { file_path?: string; file_name?: string; files?: FileSpec[]; caption?: string; device?: string }
interface SentMeta { name: string; size: number }

const FILE_PATH_DESC = 'Path to the file to send. Local path (absolute, or relative to the working directory); with `device`, an absolute path on that device.';

/** Exactly one of `file_path` / `files` names what to send. */
function fileSpecs(input: SendFileInput): FileSpec[] {
  const hasList = !!input.files?.length;
  if (hasList === !!input.file_path) throw new Error('Pass either `file_path` or a non-empty `files`, not both');
  return hasList ? input.files! : [{ file_path: input.file_path!, file_name: input.file_name }];
}

/** With `device` the path belongs to another machine: it cannot be resolved or stat'ed here, and a
 *  relative path would be meaningless there. The daemon validates it on the device. */
function resolveFilePath(filePath: string, device?: string): string {
  if (device) {
    if (!isAbsoluteFilePath(filePath)) throw new Error(`file_path must be absolute when \`device\` is set: ${filePath}`);
    return filePath;
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  if (!fs.statSync(resolved).isFile()) throw new Error(`Not a file: ${resolved}`);
  return resolved;
}

/** One file keeps the original single-file wire shape; several go as one `files` group. */
function uiFileBody(sessionId: string, input: SendFileInput) {
  const files = fileSpecs(input).map(f => ({ filePath: resolveFilePath(f.file_path, input.device), fileName: f.file_name }));
  const base = { sessionId, caption: input.caption, device: input.device };
  return files.length === 1 ? { ...base, ...files[0] } : { ...base, files };
}

function sentSummary(sent: SentMeta[], device?: string): string {
  const from = device ? ` from ${device}` : '';
  if (sent.length === 1) return `Sent file to the user${from}: ${sent[0].name} (${sent[0].size} bytes)`;
  const lines = sent.map(m => `- ${m.name} (${m.size} bytes)`);
  return [`Sent ${sent.length} files to the user${from}:`, ...lines].join('\n');
}

async function sendFiles(ctx: CortexToolContext, input: SendFileInput): Promise<string> {
  const sessionId = webSessionId(ctx);
  if (!sessionId) throw new Error('No web session in context — send_file is only usable inside a Web UI chat session');
  const { body } = await requestLoopbackJson(
    'POST', `${ctx.webhookBaseUrl}/webhook/ui-file`, uiFileBody(sessionId, input), webhookAuthHeaders(ctx),
  );
  if (!body.success) throw new Error(body.error || 'send_file failed');
  return sentSummary(Array.isArray(body.data) ? body.data : [body.data], input.device);
}

export function registerUiFileTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'send_file',
    'Send one or more files to the user in this chat. Use this whenever you want to share files you produced — a report, plot, image, dataset, log, PDF, etc. Each file appears as a downloadable card in the conversation (images preview inline). Pass `file_path` for one file, or `files` to send several at once as one grouped message sharing a single caption. Paths are local, or set `device` to send files that live on a remote device instead.',
    {
      file_path: z.string().optional().describe(`${FILE_PATH_DESC} Use this OR \`files\`.`),
      file_name: z.string().optional().describe('Optional filename override shown to the user (with `file_path`).'),
      files: z.array(z.object({
        file_path: z.string().describe(FILE_PATH_DESC),
        file_name: z.string().optional().describe('Optional filename override shown to the user.'),
      })).optional().describe('Several files to send together as one message, in this order. Use this OR `file_path`.'),
      caption: z.string().optional().describe('Optional short message shown alongside the file(s).'),
      device: z.string().optional().describe('Name of a connected remote device (as used by remote_bash). The files are read there and streamed back. Omit for files on this server.'),
    },
    async (input: SendFileInput) => {
      try {
        return { content: [{ type: 'text', text: await sendFiles(ctx, input) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to send file: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
