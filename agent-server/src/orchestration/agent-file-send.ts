// input:  { sessionId, filePath, fileName?, caption? } + fs + conversation history + session-events bus
// output: sendAgentFile — deliver an agent-produced file into a web chat session (20a)
// pos:    orch/ — the assistant-side mirror of the user composer's upload (15a). Copies the file into
//         the session's workspace/outputs/<sessionId>/ area (a stable, download-safe location under
//         WORKSPACE_DIR), records it as an assistant message carrying file attachments (so it survives
//         reload via sessions.transcript), and publishes a `session.message` event (so the live web UI
//         renders the file card immediately). Invoked by the daemon `/webhook/ui-file` route on behalf
//         of the web-only `send_file` MCP tool. Deps are injectable for tests.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { promises as fs } from 'fs';
import { WORKSPACE_DIR } from '@core/paths.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { publishSessionMessage, type SessionMessagePayload } from './session-events.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';

export type { SessionMessagePayload };

/** Physical directory backing the UI-relative `workspace/outputs/` prefix. */
const OUTPUTS_DIR = path.join(WORKSPACE_DIR, 'outputs');

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

/** Classify a MIME type into the AttachmentMeta `type` bucket (mirrors the upload classifier). */
export function classifyAttachment(mimeType: string): 'image' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/** Sanitize a filename: keep alphanumeric, dot, hyphen, underscore; replace the rest. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+/, '').substring(0, 200) || 'file';
}

/** Find an available filename in `dir`: on collision try `name_1`, `name_2`, … */
async function resolveAvailablePath(dir: string, base: string): Promise<{ destPath: string; finalName: string }> {
  const extIdx = base.lastIndexOf('.');
  const stem = extIdx > 0 ? base.slice(0, extIdx) : base;
  const ext = extIdx > 0 ? base.slice(extIdx) : '';
  let candidate = base;
  let counter = 0;
  while (true) {
    const p = path.join(dir, candidate);
    try {
      await fs.access(p);
      counter++;
      candidate = `${stem}_${counter}${ext}`;
    } catch {
      return { destPath: p, finalName: candidate };
    }
  }
}

export interface CopiedFile {
  /** UI-relative path under `workspace/` (what the file card + download endpoint reference). */
  relPath: string;
  name: string;
  size: number;
}

/**
 * Copy an agent-produced file into the session's `workspace/outputs/<sessionId>/` area and return
 * its UI-relative path + final name + byte size. Copying (rather than referencing the source in
 * place) gives every agent-sent file a predictable location strictly under WORKSPACE_DIR, so the
 * download endpoint can serve it with a single-root traversal guard and never expose arbitrary
 * filesystem paths. Throws when the source is missing or not a regular file.
 */
export async function copyFileIntoOutputs(a: { sessionId: string; filePath: string; fileName?: string }): Promise<CopiedFile> {
  const resolvedSrc = path.isAbsolute(a.filePath) ? a.filePath : path.resolve(process.cwd(), a.filePath);
  let stat: import('fs').Stats;
  try {
    stat = await fs.stat(resolvedSrc);
  } catch {
    throw new Error(`File not found: ${resolvedSrc}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${resolvedSrc}`);

  const baseName = sanitizeFilename(a.fileName || path.basename(resolvedSrc));
  const dir = path.join(OUTPUTS_DIR, a.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const { destPath, finalName } = await resolveAvailablePath(dir, baseName);
  await fs.copyFile(resolvedSrc, destPath);
  const outStat = await fs.stat(destPath);
  return { relPath: `workspace/outputs/${a.sessionId}/${finalName}`, name: finalName, size: outStat.size };
}

export interface SendAgentFileArgs {
  sessionId: string;
  filePath: string;
  fileName?: string;
  /** Optional caption shown alongside the file card. */
  caption?: string;
}

export interface SendAgentFileDeps {
  copyIntoOutputs?: (a: { sessionId: string; filePath: string; fileName?: string }) => Promise<CopiedFile>;
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
