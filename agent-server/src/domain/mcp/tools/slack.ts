// input:  McpServer, Slack WebClient, fallback channel
// output: slack_send_file tool registration
// pos:    MCP tool for uploading files to Slack
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebClient } from '@slack/web-api';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { TokenBucketRateLimiter } from '../../../platform/utils/rate-limiter.js';
import { Icons } from '../../../core/icons.js';

export interface SlackToolDeps {
  slack: WebClient | null;
  fallbackChannel: string | undefined;
  branchMachine: string | undefined;
  callbackSource: string | undefined;
}

/** Per-process rate limiter for the MCP server's Slack API calls.
 *  The MCP server runs as a separate subprocess, so it maintains its own
 *  rate limiter state. Configure via the same CORTEX_SLACK_RL_* env vars. */
function createRateLimiter(): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter({
    globalCapacity: _envNum('CORTEX_SLACK_RL_GLOBAL_CAPACITY', 20),
    globalRefillPerSec: _envNum('CORTEX_SLACK_RL_GLOBAL_REFILL_PER_SEC', 1),
    perChannelCapacity: _envNum('CORTEX_SLACK_RL_CHANNEL_CAPACITY', 1),
    perChannelRefillPerSec: _envNum('CORTEX_SLACK_RL_CHANNEL_REFILL_PER_SEC', 1),
  });
}

function _envNum(key: string, def: number): number {
  const v = process.env[key];
  return v ? Number(v) : def;
}

function withReplyPrefix(text: string | undefined, { branchMachine, callbackSource }: { branchMachine?: string; callbackSource?: string }): string | undefined {
  if (!text) return text;
  if (branchMachine) return `${Icons.satellite} *[branch: ${branchMachine}]* ${text}`;
  if (callbackSource) return `${Icons.reply} *[callback: ${callbackSource}]* ${text}`;
  return text;
}

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

/** Strip the 'slack:' prefix from a channel ID (tolerates already-bare values for back-compat).
 *  Multi-platform conduits carry the 'slack:' prefix from SLACK_CHANNEL env var;
 *  the Slack WebClient API expects bare channel IDs.
 *  This mirrors SlackAdapter._unwrap() behavior. */
function stripSlackPrefix(channelId: string): string {
  const PREFIX = 'slack:';
  if (!channelId) return channelId;
  return channelId.startsWith(PREFIX) ? channelId.slice(PREFIX.length) : channelId;
}

/** Lazy-initialized per-process rate limiter for Slack API calls in the MCP server. */
let _rateLimiter: TokenBucketRateLimiter | null = null;

export async function uploadFileToSlack(slack: WebClient, { channel, filePath, fileName, title, initialComment }: {
  channel: string; filePath: string; fileName?: string; title?: string; initialComment?: string;
}): Promise<{ path: string; fileName: string; size: number }> {
  const rl = _rateLimiter ?? (_rateLimiter = createRateLimiter());
  const { resolved, size } = resolveReadableFilePath(filePath);
  const body = fs.readFileSync(resolved);
  const uploadName = fileName || path.basename(resolved);

  // Strip 'slack:' prefix from channel ID for Slack API compatibility
  const bareChannel = stripSlackPrefix(channel);

  if (initialComment) {
    await rl.acquire('chat.postMessage', bareChannel);
    await slack.chat.postMessage({ channel: bareChannel, text: initialComment });
  }

  await rl.acquire('files.getUploadURLExternal', bareChannel);
  const uploadInit = await slack.files.getUploadURLExternal({
    filename: uploadName,
    length: size,
  });

  if (!uploadInit?.upload_url || !uploadInit?.file_id) {
    throw new Error('Slack upload initialization failed: missing upload_url or file_id');
  }

  const uploadRes = await fetch(uploadInit.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });

  if (!uploadRes.ok) {
    const errBody = await uploadRes.text().catch(() => '');
    const suffix = errBody ? `: ${errBody.slice(0, 300)}` : '';
    throw new Error(`Slack file upload failed (${uploadRes.status} ${uploadRes.statusText})${suffix}`);
  }

  await rl.acquire('files.completeUploadExternal', bareChannel);
  await slack.files.completeUploadExternal({
    files: [{ id: uploadInit.file_id, title: title || uploadName }],
    channel_id: bareChannel,
  });

  return { path: resolved, fileName: uploadName, size };
}

export function registerSlackTools(server: McpServer, deps: SlackToolDeps): void {
  server.tool(
    'slack_send_file',
    'Upload a local file to Slack. Use this when you need to share a file (image, log, data, etc.) with the user.',
    {
      file_path: z.string().describe('Local file path to upload'),
      file_name: z.string().optional().describe('Optional filename override shown in Slack'),
      title: z.string().optional().describe('Optional file title shown in Slack'),
      comment: z.string().optional().describe('Optional comment to accompany the file'),
    },
    async ({ file_path, file_name, title, comment }: {
      file_path: string; file_name?: string; title?: string; comment?: string;
    }) => {
      try {
        const channel = deps.fallbackChannel;
        if (!channel) throw new Error('No routing channel available');
        if (!deps.slack) throw new Error('Missing SLACK_BOT_TOKEN');

        const uploaded = await uploadFileToSlack(deps.slack, {
          channel,
          filePath: file_path,
          fileName: file_name,
          title,
          initialComment: comment || undefined,
        });
        return {
          content: [{
            type: 'text',
            text: `File uploaded: ${uploaded.fileName} (${uploaded.size} bytes)`,
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to upload file: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
