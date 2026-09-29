import * as fs from 'fs';
import * as path from 'path';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { webhookAuthHeaders, type CortexToolContext } from './context.js';

/** Cross-platform absolute-path check (the server runs on Linux but validates paths for Windows
 *  clients, where `D:\…` is absolute and `/foo` is not what the user means). */
export function isAbsoluteFilePath(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  // Windows absolute: D:\, D:/, etc.
  if (/^[A-Za-z]:[/\\]/.test(p)) return true;
  return false;
}

/** Resolve a local path against the cwd and check it names a readable regular file. */
export function resolveReadableFilePath(filePathInput: string): { resolved: string; size: number } {
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

/** Strip a platform prefix ('slack:', 'feishu:') from a channel ID, tolerating already-bare values.
 *  Multi-platform conduits carry the prefix; the platform APIs expect bare channel IDs. This
 *  mirrors the adapters' _unwrap() behavior. */
export function stripChannelPrefix(channelId: string, prefix: string): string {
  if (!channelId) return channelId;
  return channelId.startsWith(prefix) ? channelId.slice(prefix.length) : channelId;
}

/** How long a staged transfer may take end to end. Generous: the transfer crosses whatever tunnel
 *  the device is behind, and the alternative to waiting is a file the user never receives. */
const STAGE_TIMEOUT_MS = 10 * 60_000;

export interface StagedFile {
  localPath: string;
  name: string;
  size: number;
}

/**
 * Bring a remote device's file to this machine so a sender that uploads from disk (Slack, Feishu)
 * can treat it like any local file. The transfer itself happens in the daemon — client-manager and
 * the reverse channel live there — so this is only the proxy call.
 */
export async function stageRemoteFile(
  ctx: CortexToolContext, device: string, filePath: string,
): Promise<StagedFile> {
  if (!isAbsoluteFilePath(filePath)) {
    throw new Error('file_path must be absolute when `device` is set');
  }
  const { body } = await requestLoopbackJson(
    'POST',
    `${ctx.webhookBaseUrl}/webhook/remote-fetch`,
    { device, filePath },
    webhookAuthHeaders(ctx),
    STAGE_TIMEOUT_MS,
  );
  if (!body.success) throw new Error(body.error || `Failed to fetch ${filePath} from ${device}`);
  return body.data as StagedFile;
}

/**
 * Run `use` against a device's file, then delete the staged copy. The copy is a transfer buffer,
 * not a result: leaving it behind would grow the workspace by the size of every file ever sent.
 */
export async function withStagedRemoteFile<T>(
  ctx: CortexToolContext, device: string, filePath: string, use: (staged: StagedFile) => Promise<T>,
): Promise<T> {
  const staged = await stageRemoteFile(ctx, device, filePath);
  try {
    return await use(staged);
  } finally {
    await fs.promises.rm(path.dirname(staged.localPath), { recursive: true, force: true }).catch(() => {});
  }
}
