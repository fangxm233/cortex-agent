// input:  file name and optional MIME type
// output: in-app document kind or null
// pos:    Pure classifier shared by desktop and mobile file surfaces
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// PDF renders via pdf.js; text renders as Markdown or monospace text; other files download.
// `html` is the RENDERED view kind and is deliberately absent from the classifier below: it is
// minted only from an attachment the server marked `type: 'view'` (see docKindOfAttachment), never
// from a filename or MIME type. That is what keeps a `.html` a user uploaded un-executable — it
// still classifies as `text` and opens as source.

export type DocKind = 'pdf' | 'text' | 'html';

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

/**
 * Kind for a chat attachment. Identical to `docKindOf` except for the one case that matters: an
 * attachment the SERVER minted as a view (`send_view`) renders as HTML. Rendering intent travels
 * with the attachment bucket, not with the file's name — an uploaded `.html` has no way to acquire
 * it, and an agent that wants to hand over an HTML file for reading still gets the source view.
 */
export function docKindOfAttachment(a: { name: string; mimeType?: string; type?: string }): DocKind | null {
  if (a.type === 'view') return 'html';
  return docKindOf(a.name, a.mimeType);
}
