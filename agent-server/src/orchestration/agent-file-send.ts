import * as path from 'path';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { publishSessionMessage, type SessionMessagePayload } from './session-events.js';
import { copyFileIntoOutputs, receiveIntoOutputs, type StoredOutput } from './outputs-store.js';
import { fetchRemoteFile, prepareRemoteFetch } from '@domain/remote/device-file.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';

export type { SessionMessagePayload };
export { copyFileIntoOutputs };
/** @deprecated name kept for existing callers/tests; `StoredOutput` is the current name. */
export type CopiedFile = StoredOutput;

/** Minimal extension → MIME map for the common file kinds an agent shares. Anything unknown falls
 *  back to application/octet-stream (still downloadable, just no inline preview). */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv',
  '.txt': 'text/plain', '.md': 'text/markdown', '.log': 'text/plain',
  '.html': 'text/html', '.zip': 'application/zip',
};

/** Infer a MIME type from a filename's extension. */
export function extToMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Classify a MIME type into the AttachmentMeta `type` bucket (mirrors the upload classifier).
 *  Deliberately narrower than `AttachmentMeta['type']`: it can never return `'view'`, so a file the
 *  agent SENDS is never marked renderable by accident. Only `sendAgentView` mints that bucket. */
export function classifyAttachment(mimeType: string): 'image' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

export interface SendAgentFileArgs {
  sessionId: string;
  filePath: string;
  fileName?: string;
  /** Optional caption shown alongside the file card. */
  caption?: string;
  /** Name of a connected cortex-client; the path is then read on THAT device, not on the server. */
  device?: string;
}

export interface SendAgentFileDeps {
  copyIntoOutputs?: (a: { sessionId: string; filePath: string; fileName?: string }) => Promise<StoredOutput>;
  /** Injectable twin of `copyIntoOutputs` for the remote path. */
  fetchIntoOutputs?: (a: { sessionId: string; device: string; filePath: string; fileName?: string }) => Promise<StoredOutput>;
  appendAssistant?: (sessionId: string, opts: { text: string; ts?: string; attachments?: AttachmentMeta[] }) => Promise<void>;
  publish?: (p: SessionMessagePayload) => void;
  now?: () => string;
}

/** Nothing the chat can usefully show is this big, and the cap is what stops one `send_file` from
 *  filling the disk with a transfer nobody can cancel. */
const MAX_REMOTE_FILE_BYTES = 200 * 1024 * 1024;

/** Stream a device's file straight into the session's outputs area. */
async function defaultFetchIntoOutputs(
  a: { sessionId: string; device: string; filePath: string; fileName?: string },
): Promise<StoredOutput> {
  // Stat first: it is what rejects a bad path or an oversized file before anything is reserved on
  // disk, and it supplies the default display name. The device derives that name with ITS own path
  // rules — basename() here would mis-split a Windows path on a Linux server.
  const stat = await prepareRemoteFetch({
    device: a.device, filePath: a.filePath, maxBytes: MAX_REMOTE_FILE_BYTES,
  });
  return receiveIntoOutputs(
    { sessionId: a.sessionId, fileName: a.fileName || stat.name },
    destPath => fetchRemoteFile({ device: a.device, filePath: a.filePath, destPath, stat }).then(() => {}),
  );
}

/**
 * Deliver a file into a web chat session as an agent-sent attachment (20a). Copies the file into the
 * session's outputs area, records an assistant message carrying the attachment (persisted, so it is
 * replayed by sessions.transcript on reload), and publishes a `session.message` event sharing the
 * SAME `ts` as the history entry so the web UI's content de-dup (transcript vs live-tail) keys them
 * identically. Returns the AttachmentMeta describing the delivered file.
 */
export async function sendAgentFile(args: SendAgentFileArgs, deps: SendAgentFileDeps = {}): Promise<AttachmentMeta> {
  const copy = deps.copyIntoOutputs ?? copyFileIntoOutputs;
  const fetchIn = deps.fetchIntoOutputs ?? defaultFetchIntoOutputs;
  const append = deps.appendAssistant ?? ((sid, o) => conversationHistory.appendAssistant(sid, o));
  const publish = deps.publish ?? publishSessionMessage;
  const now = deps.now ?? (() => new Date().toISOString());

  // Only the source of the bytes differs. Once the file is in the outputs area, a device's file is
  // an ordinary attachment — same card, same download endpoint, same transcript row.
  const { relPath, name, size } = args.device
    ? await fetchIn({ sessionId: args.sessionId, device: args.device, filePath: args.filePath, fileName: args.fileName })
    : await copy({ sessionId: args.sessionId, filePath: args.filePath, fileName: args.fileName });
  const mimeType = extToMime(name);
  const meta: AttachmentMeta = { name, path: relPath, size, mimeType, type: classifyAttachment(mimeType) };
  const ts = now();
  const channel = `web:${args.sessionId}`;
  const caption = args.caption ?? '';

  await append(args.sessionId, { text: caption, ts, attachments: [meta] });
  publish({ sessionId: args.sessionId, channel, role: 'assistant', text: caption, attachments: [meta], ts });
  return meta;
}
