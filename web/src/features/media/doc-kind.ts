// Pure helper: classify a plain-file attachment into a document kind the in-app DocViewer can render
// inline — 'pdf' | 'text' | null. PDF renders via pdf.js (canvas); text renders as Markdown (.md) or
// a monospace <pre>. Everything else (zip, xlsx, binaries) is null → download. Shared by the desktop
// MessageStream file cards and the mobile AttachmentTile. Image/video are handled by media-kind.ts;
// this classifier is only consulted for the `file` attachment type.

export type DocKind = 'pdf' | 'text';

// Text-family extensions we can safely show as plain text / Markdown. Lower-case, no leading dot.
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'json', 'jsonl', 'ndjson', 'csv', 'tsv',
  'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'html', 'htm', 'css', 'scss',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'kt',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'rb', 'php', 'swift', 'sh', 'bash', 'zsh',
  'sql', 'r', 'lua', 'pl', 'tex', 'diff', 'patch', 'gitignore', 'dockerfile', 'conf', 'cfg', 'properties',
]);

/** Markdown extensions get the rich renderer; other text goes to a monospace <pre>. */
export function isMarkdownName(name: string): boolean {
  const ext = extOf(name);
  return ext === 'md' || ext === 'markdown';
}

function extOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const i = base.lastIndexOf('.');
  // No dot, or a leading-dot dotfile with no further extension (".env" → "env" handled below).
  if (i <= 0) {
    // Dotfiles like ".gitignore" / ".env" — treat the trailing segment as the extension.
    if (base.startsWith('.') && base.length > 1) return base.slice(1).toLowerCase();
    return '';
  }
  return base.slice(i + 1).toLowerCase();
}

/**
 * Map a plain file's name (+ optional mimeType) to the inline-previewable document kind, or null.
 * PDF wins on `.pdf` / `application/pdf`; text wins on the extension allow-list or a `text/*` /
 * `application/json` mimeType. Case-insensitive; robust to paths and dotfiles.
 */
export function docKindOf(name: string, mimeType?: string): DocKind | null {
  const ext = extOf(name);
  const mt = (mimeType ?? '').toLowerCase();

  if (ext === 'pdf' || mt === 'application/pdf') return 'pdf';

  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (mt.startsWith('text/')) return 'text';
  if (mt === 'application/json' || mt === 'application/xml' || mt === 'application/x-yaml') return 'text';

  return null;
}

/** True when the file can be opened in the in-app DocViewer (pdf or text). */
export function isDocPreviewable(name: string, mimeType?: string): boolean {
  return docKindOf(name, mimeType) !== null;
}
