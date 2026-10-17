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

// Match web/src/lib/markdown.ts: destinations are verbatim, not CommonMark-normalized.
const TARGET = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))+`;
const INLINE_MEDIA = new RegExp([
  String.raw`\*\*[^*]+\*\*`,
  String.raw`(?<ticks>\x60+).*?\k<ticks>`,
  String.raw`!\[[^\]]*\]\((?<src>${TARGET})\)`,
  String.raw`\[[^\]]+\]\(${TARGET}\)`,
  String.raw`\*[^*]+\*`,
  String.raw`_[^_]+_`,
].join('|'), 'g');

function withoutFencedCode(markdown: string): string {
  const body: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (fence) {
      const trimmed = line.trim();
      if (trimmed.length >= fence.length && [...trimmed].every(char => char === fence!.marker)) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }
    body.push(line);
  }
  return body.join('\n');
}

export function extractMediaSources(markdown: string): string[] {
  const sources = new Set<string>();
  for (const match of withoutFencedCode(markdown).matchAll(INLINE_MEDIA)) {
    if (match.groups?.src) sources.add(match.groups.src);
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
