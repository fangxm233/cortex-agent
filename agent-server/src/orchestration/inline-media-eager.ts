import { createLogger } from '@core/log.js';
import { parseMediaSrc, snapshotInlineMedia } from './inline-media.js';
import type { ResolveMediaInput } from '@domain/ui-service/inline-media-types.js';

const log = createLogger('inline-media');
type MessageMedia = Omit<ResolveMediaInput, 'src'> & { text: string };
interface EagerDeps {
  snapshot: typeof snapshotInlineMedia;
  warn: (message: string) => void;
}
const defaults: EagerDeps = { snapshot: snapshotInlineMedia, warn: message => log.warn(message) };

function unescapeMarkdown(src: string): string {
  return src.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
}

/** Read a Markdown destination, retaining nested parentheses and Windows path separators. */
function destination(text: string): { src: string; end: number } {
  const angle = /^<([^<>\n]*)>/.exec(text);
  if (angle) return { src: unescapeMarkdown(angle[1]), end: angle[0].length };
  let depth = 0;
  let end = 0;
  for (; end < text.length; end++) {
    const char = text[end];
    if (char === '\\' && /[\\()]/.test(text[end + 1] ?? '')) { end++; continue; }
    if (/\s/.test(char) || (char === ')' && depth === 0)) break;
    depth += Number(char === '(') - Number(char === ')');
  }
  return { src: unescapeMarkdown(text.slice(0, end)), end };
}

function inlineDestination(text: string): string | undefined {
  const { src, end } = destination(text);
  const suffix = text.slice(end);
  if (!/^\s*(?:(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\))\s*)?\)/.test(suffix)) return undefined;
  return src || undefined;
}

function normalizeLabel(label: string): string {
  return unescapeMarkdown(label).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** No HTML or normal links: only Markdown image nodes, outside fenced/inline code. */
export function extractMediaSources(markdown: string): string[] {
  const text = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '')
    .replace(/(`+)[\s\S]*?\1/g, '');
  const definitions = new Map<string, string>();
  for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(.+)$/gm)) {
    definitions.set(normalizeLabel(match[1]), destination(match[2]).src);
  }
  const sources = new Set<string>();
  for (const match of text.matchAll(/(?<!\\)!\[((?:\\.|[^\]\\])*)\](?:\[([^\]]*)\])?/g)) {
    const rest = text.slice(match.index! + match[0].length);
    const src = rest.startsWith('(')
      ? inlineDestination(rest.slice(1).trimStart())
      : definitions.get(normalizeLabel(match[2] || match[1]));
    if (src) sources.add(src);
  }
  return [...sources];
}

async function snapshotReference(message: MessageMedia, src: string, deps: EagerDeps): Promise<void> {
  try {
    const source = parseMediaSrc(src);
    if (source.type !== 'local' && source.type !== 'device') return;
    const result = await deps.snapshot({ sessionId: message.sessionId, ts: message.ts, src });
    if ('error' in result) deps.warn(`Inline media snapshot failed (${result.error.code}): ${src}: ${result.error.reason}`);
  } catch (error) {
    deps.warn(`Inline media snapshot failed: ${src}: ${String(error)}`);
  }
}

/** Called after the row is durable; an unavailable image must never fail the assistant turn. */
export async function eagerSnapshotInlineMedia(message: MessageMedia, deps: EagerDeps = defaults): Promise<void> {
  await Promise.all(extractMediaSources(message.text).map(src => snapshotReference(message, src, deps)));
}
