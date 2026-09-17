import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { guard, ok, unwrap, type FeishuToolDeps } from './types.js';
import { uploadFeishuImage } from '@platform/adapters/feishu-image.js';
import { withStagedRemoteFile } from '../tools/remote-file.js';
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

/** Upload as a chat file and return its file_key. */
async function uploadFileKey(client: LarkClient, resolved: string, uploadName: string): Promise<string> {
  const uploadRes = await (client as any).im.v1.file.create({
    data: {
      file_type: inferFeishuFileType(uploadName),
      file_name: uploadName,
      file: fs.readFileSync(resolved),
    },
  });
  const fileKey = unwrap<{ file_key?: string }>(uploadRes).file_key;
  if (!fileKey) throw new Error('Feishu file upload failed: no file_key returned');
  return fileKey;
}

export async function uploadFileToFeishu(
  client: LarkClient,
  { channel, filePath, fileName, title }: {
    channel: string; filePath: string; fileName?: string; title?: string;
  },
): Promise<{ path: string; fileName: string; size: number }> {
  const { resolved, size } = resolveReadableFilePath(filePath);
  const uploadName = fileName || path.basename(resolved);

  // Strip 'feishu:' prefix from channel ID for Feishu API compatibility
  const bareChannel = stripFeishuPrefix(channel);

  // An image goes into the chat as an image, so the user sees it without opening anything. The file
  // card below stays the fallback: non-images, images over 10 MB, and apps without `im:resource`.
  const imageKey = await uploadFeishuImage(client, resolved, size);
  const msgType = imageKey ? 'image' : 'file';
  const msgContent = imageKey
    ? JSON.stringify({ image_key: imageKey })
    : JSON.stringify({ file_key: await uploadFileKey(client, resolved, uploadName) });

  await (client as any).im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: bareChannel,
      msg_type: msgType,
      content: msgContent,
    },
  });

  return { path: resolved, fileName: uploadName, size };
}

export function registerFileTools(server: McpServer, deps: FeishuToolDeps): void {
  server.tool(
    'feishu_send_file',
    'Upload a file to Feishu. Use this when you need to share a file (document, image, archive, etc.) with users in a Feishu chat or channel. The file may be on this server or, with `device`, on a connected remote device.',
    {
      file_path: z.string().describe('File path to upload. Local path, or an absolute path on `device`.'),
      file_name: z.string().optional().describe('Optional filename override shown in Feishu'),
      title: z.string().optional().describe('Optional file title shown in Feishu'),
      channel: z.string().optional().describe('Optional chat/channel ID (uses route context if not provided)'),
      device: z.string().optional().describe('Name of a connected remote device (as used by remote_bash). Omit for files on this server.'),
    },
    async ({ file_path, file_name, title, channel: explicitChannel, device }) =>
      guard(deps.client, async (client) => {
        const channel = explicitChannel || deps.fallbackChannel || '';
        if (!channel) throw new Error('No Feishu channel available (no session channel or channel parameter)');

        const upload = (filePath: string, name?: string) => uploadFileToFeishu(client, {
          channel,
          filePath,
          fileName: name,
          title,
        });

        // The Feishu upload reads from a path, so a device's file is staged to disk first and
        // removed again once the upload has taken its bytes.
        if (!device) {
          const uploaded = await upload(file_path, file_name);
          return ok(`File uploaded: ${uploaded.fileName} (${uploaded.size} bytes)`);
        }
        if (!deps.ctx) throw new Error('`device` is not available in this context');
        const uploaded = await withStagedRemoteFile(deps.ctx, device, file_path,
          staged => upload(staged.localPath, file_name || staged.name));
        return ok(`File uploaded from ${device}: ${uploaded.fileName} (${uploaded.size} bytes)`);
      }),
  );
}
