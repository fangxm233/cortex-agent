// input:  file args, filesystem, conversation history, session events
// output: sendAgentFile and safe workspace copy metadata
// pos:    delivers agent-produced files into Web chat sessions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { publishSessionMessage, type SessionMessagePayload } from './session-events.js';
import { copyFileIntoOutputs, type StoredOutput } from './outputs-store.js';
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
}

export interface SendAgentFileDeps {
  copyIntoOutputs?: (a: { sessionId: string; filePath: string; fileName?: string }) => Promise<StoredOutput>;
  appendAssistant?: (sessionId: string, opts: { text: string; ts?: string; attachments?: AttachmentMeta[] }) => Promise<void>;
  publish?: (p: SessionMessagePayload) => void;
  now?: () => string;
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
  const append = deps.appendAssistant ?? ((sid, o) => conversationHistory.appendAssistant(sid, o));
  const publish = deps.publish ?? publishSessionMessage;
  const now = deps.now ?? (() => new Date().toISOString());

  const { relPath, name, size } = await copy({ sessionId: args.sessionId, filePath: args.filePath, fileName: args.fileName });
  const mimeType = extToMime(name);
  const meta: AttachmentMeta = { name, path: relPath, size, mimeType, type: classifyAttachment(mimeType) };
  const ts = now();
  const channel = `web:${args.sessionId}`;
  const caption = args.caption ?? '';

  await append(args.sessionId, { text: caption, ts, attachments: [meta] });
  publish({ sessionId: args.sessionId, channel, role: 'assistant', text: caption, attachments: [meta], ts });
  return meta;
}
