// input:  McpServer and Feishu LarkClient
// output: feishu_send_file tool registration
// pos:    MCP tool for uploading files to Feishu
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { guard, ok, unwrap, type FeishuToolDeps } from './types.js';
import type { LarkClient } from './client.js';

function resolveReadableFilePath(filePathInput: string): { resolved: string; size: number } {
  const resolved = path.isAbsolute(filePathInput)
    ? filePathInput
    : path.resolve(process.cwd(), filePathInput);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  return { resolved, size: stat.size };
}

/** Strip the 'feishu:' prefix from a channel ID (tolerates already-bare values for back-compat).
 *  Multi-platform conduits carry the 'feishu:' prefix from FEISHU_CHANNEL env var;
 *  the Feishu OpenAPI expects bare channel IDs (e.g., oc_123abc).
 *  This mirrors FeishuAdapter._unwrap() behavior. */
function stripFeishuPrefix(channelId: string): string {
  const PREFIX = 'feishu:';
  if (!channelId) return channelId;
  return channelId.startsWith(PREFIX) ? channelId.slice(PREFIX.length) : channelId;
}

/** Infer Feishu file type from file extension (used by the OpenAPI file.create call).
 *  Feishu API only supports specific file_type values:
 *  opus, mp4, pdf, doc, xls, ppt, stream
 *  For unsupported types, use 'stream' as a catch-all. */
function inferFeishuFileType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const typeMap: Record<string, string> = {
    '.pdf': 'pdf',
    '.doc': 'doc',
    '.xls': 'xls',
    '.ppt': 'ppt',
    '.mp4': 'mp4',
    '.opus': 'opus',
  };
  // Feishu API doesn't support 'text', 'image', 'zip', 'rar', 'docx', 'xlsx', 'pptx'
  // Use 'stream' as fallback for all unsupported types
  return typeMap[ext] || 'stream';
}

export async function uploadFileToFeishu(
  client: LarkClient,
  { channel, filePath, fileName, title }: {
    channel: string; filePath: string; fileName?: string; title?: string;
  },
): Promise<{ path: string; fileName: string; size: number }> {
  const { resolved, size } = resolveReadableFilePath(filePath);
  const body = fs.readFileSync(resolved);
  const uploadName = fileName || path.basename(resolved);

  // Strip 'feishu:' prefix from channel ID for Feishu API compatibility
  const bareChannel = stripFeishuPrefix(channel);

  // Upload file to get file_key
  const uploadRes = await (client as any).im.v1.file.create({
    data: {
      file_type: inferFeishuFileType(uploadName),
      file_name: uploadName,
      file: body,
    },
  });

  const fileKey = unwrap<{ file_key?: string }>(uploadRes).file_key;
  if (!fileKey) throw new Error('Feishu file upload failed: no file_key returned');

  // Send file message to channel
  const msgContent = JSON.stringify({ file_key: fileKey });
  await (client as any).im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: bareChannel,
      msg_type: 'file',
      content: msgContent,
    },
  });

  return { path: resolved, fileName: uploadName, size };
}

export function registerFileTools(server: McpServer, deps: FeishuToolDeps): void {
  server.tool(
    'feishu_send_file',
    'Upload a local file to Feishu. Use this when you need to share a file (document, image, archive, etc.) with users in a Feishu chat or channel.',
    {
      file_path: z.string().describe('Local file path to upload'),
      file_name: z.string().optional().describe('Optional filename override shown in Feishu'),
      title: z.string().optional().describe('Optional file title shown in Feishu'),
      channel: z.string().optional().describe('Optional chat/channel ID (uses route context if not provided)'),
    },
    async ({ file_path, file_name, title, channel: explicitChannel }) =>
      guard(deps.client, async (client) => {
        const channel = explicitChannel || (process.env.FEISHU_CHANNEL ?? '');
        if (!channel) throw new Error('No Feishu channel available (missing FEISHU_CHANNEL env or channel parameter)');

        const uploaded = await uploadFileToFeishu(client, {
          channel,
          filePath: file_path,
          fileName: file_name,
          title,
        });
        return ok(`File uploaded: ${uploaded.fileName} (${uploaded.size} bytes)`);
      }),
  );
}
