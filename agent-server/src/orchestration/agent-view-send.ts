// input:  view args (inline html or an html file), conversation history, session events
// output: sendAgentView + the view size limits shared with the MCP tool
// pos:    delivers agent-authored HTML views into Web chat sessions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { conversationHistory } from '@store/conversation-history-repo.js';
import { publishSessionMessage, type SessionMessagePayload } from './session-events.js';
import { copyFileIntoOutputs, writeTextIntoOutputs, sanitizeDisplayFilename, type StoredOutput } from './outputs-store.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';

/** Views land one directory deeper than plain files so the two kinds never collide on name, and so
 *  "what did the agent render in this session" is answerable with a single `ls`. */
export const VIEW_SUBDIR = 'views';

/** Inline `html` ceiling. Anything larger belongs in a file the agent writes first — an inline
 *  payload this big has already cost the model its own context once. */
export const MAX_INLINE_HTML_BYTES = 256 * 1024;

/** File ceiling, matching the web DocViewer's own text-preview limit (TEXT_PREVIEW_LIMIT). Past
 *  this the renderer would refuse to display it anyway, so failing here gives a better message. */
export const MAX_VIEW_FILE_BYTES = 2 * 1024 * 1024;

/** First-paint height of the inline card, in px. Clamped on both the server and the renderer. */
export const VIEW_HEIGHT_DEFAULT = 360;
export const VIEW_HEIGHT_MIN = 160;
export const VIEW_HEIGHT_MAX = 900;

export function clampViewHeight(height: number | undefined): number {
  if (height === undefined || !Number.isFinite(height)) return VIEW_HEIGHT_DEFAULT;
  return Math.min(VIEW_HEIGHT_MAX, Math.max(VIEW_HEIGHT_MIN, Math.round(height)));
}

/** Derive an ASCII-ish, dated storage filename from the view title. The title is model output, so
 *  it is only a naming hint — `sanitizeStorageFilename` downstream still owns safety. */
export function viewFileName(title: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'view'}-${stamp}.html`;
}

export interface SendAgentViewArgs {
  sessionId: string;
  title: string;
  /** Inline HTML document or fragment. Mutually exclusive with `filePath`. */
  html?: string;
  /** Path to an existing .html file. Mutually exclusive with `html`. */
  filePath?: string;
  /** Short line shown above the view card. */
  caption?: string;
  /** First-paint height hint in px. */
  height?: number;
}

export interface SendAgentViewDeps {
  copyIntoOutputs?: typeof copyFileIntoOutputs;
  writeIntoOutputs?: typeof writeTextIntoOutputs;
  appendAssistant?: (sessionId: string, opts: { text: string; ts?: string; attachments?: AttachmentMeta[] }) => Promise<void>;
  publish?: (p: SessionMessagePayload) => void;
  now?: () => string;
}

/**
 * Deliver an agent-authored HTML view into a web chat session. Structurally identical to
 * `sendAgentFile` — land the bytes under `workspace/outputs/<sid>/views/`, append a persisted
 * assistant message carrying the attachment, publish `session.message` with the SAME `ts` so the
 * client's transcript/live-tail de-dup keys them identically — with one deliberate difference:
 * the attachment is minted as `type: 'view'`, which is the ONLY signal that tells a renderer this
 * document is meant to be executed in a sandboxed frame rather than downloaded. Nothing derived
 * from the filename or MIME type carries that meaning, so an uploaded `.html` can never acquire it.
 *
 * The HTML itself never travels through the event or the conversation history — only the path
 * does. A 300 KB dashboard therefore costs the transcript one row, and the renderer fetches the
 * bytes on demand.
 */
export async function sendAgentView(args: SendAgentViewArgs, deps: SendAgentViewDeps = {}): Promise<AttachmentMeta & { height: number }> {
  const copy = deps.copyIntoOutputs ?? copyFileIntoOutputs;
  const writeText = deps.writeIntoOutputs ?? writeTextIntoOutputs;
  const append = deps.appendAssistant ?? ((sid, o) => conversationHistory.appendAssistant(sid, o));
  const publish = deps.publish ?? publishSessionMessage;
  const now = deps.now ?? (() => new Date().toISOString());

  const hasHtml = typeof args.html === 'string' && args.html.length > 0;
  const hasPath = typeof args.filePath === 'string' && args.filePath.length > 0;
  if (hasHtml === hasPath) {
    throw new Error('Provide exactly one of `html` or `file_path`');
  }
  const title = args.title.trim();
  if (!title) throw new Error('`title` is required');

  let stored: StoredOutput;
  if (hasHtml) {
    const bytes = Buffer.byteLength(args.html!, 'utf8');
    if (bytes > MAX_INLINE_HTML_BYTES) {
      throw new Error(
        `Inline html is ${bytes} bytes, over the ${MAX_INLINE_HTML_BYTES}-byte limit — write it to a file and pass file_path instead`,
      );
    }
    stored = await writeText({
      sessionId: args.sessionId, text: args.html!, fileName: viewFileName(title), subdir: VIEW_SUBDIR,
    });
  } else {
    stored = await copy({
      sessionId: args.sessionId, filePath: args.filePath!, subdir: VIEW_SUBDIR, maxBytes: MAX_VIEW_FILE_BYTES,
    });
  }

  const meta: AttachmentMeta = {
    // `name` carries the human title (it is what the card renders), not the storage filename —
    // the on-disk name lives in `path`. Renderers that offer a download append `.html`.
    name: sanitizeDisplayFilename(title),
    path: stored.relPath,
    size: stored.size,
    mimeType: 'text/html',
    type: 'view',
  };
  const ts = now();
  const channel = `web:${args.sessionId}`;
  const caption = args.caption ?? '';

  await append(args.sessionId, { text: caption, ts, attachments: [meta] });
  publish({ sessionId: args.sessionId, channel, role: 'assistant', text: caption, attachments: [meta], ts });
  return { ...meta, height: clampViewHeight(args.height) };
}
