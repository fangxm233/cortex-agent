import { splitFrontmatter, parseBlocks, type Block, type InlineNode } from '@/lib/markdown';

// Pure document model for the memory viewer's Read mode. One parse of the file feeds three places:
// the document header (property line, title, lede), the rendered body, and the "On this page"
// outline. No JSX and no locale: labels are resolved by the views from the keys returned here.

export type MemoryKind = 'experiment' | 'knowledge' | 'pattern';

export type MemoryStatusKey =
  | 'active' | 'valid' | 'partial' | 'challenged' | 'corrected'
  | 'superseded' | 'deprecated' | 'refined' | 'stale' | 'invalidated';

export type MemoryStatusTone = 'success' | 'amber' | 'danger' | 'muted';

export interface MemoryDocStatus {
  /** Known lifecycle status (docs/memory.md "Status lifecycle"), or null for any other value. */
  key: MemoryStatusKey | null;
  /** The status as written, shown verbatim when `key` is null. */
  raw: string;
  /** Entry a status points at after its colon (`superseded:EXP-012` → `EXP-012`), else null. */
  ref: string | null;
  tone: MemoryStatusTone;
}

export interface MemoryDocProperty {
  key: string;
  /** Display value: a YAML flow list is joined with commas; an empty list reads as an em dash. */
  value: string;
  /** True when every item is an id, a path or a hash — the only values set in the code face. */
  code: boolean;
}

export interface MemoryOutlineEntry {
  /** DOM id of the heading in the rendered body. */
  id: string;
  text: string;
  /** 0 for the shallowest outlined level, 1 for the level below it, … */
  depth: number;
}

export interface MemoryDocBlock {
  block: Block;
  /** DOM id for a heading block (scroll target of the outline); null for every other block. */
  anchor: string | null;
}

export interface MemoryDoc {
  /** Atom kind from a `type`/`kind` key, else from the `id` prefix (EXP-/K-/PAT-). */
  kind: MemoryKind | null;
  /** A `type`/`kind` value that is not a known kind, shown verbatim. */
  kindRaw: string | null;
  date: string | null;
  status: MemoryDocStatus | null;
  tags: string[];
  /** The leading level-1 heading, with a repeated `<id>:` prefix dropped (the id stays a property). */
  title: string | null;
  /** The frontmatter `summary`, rendered as the lede. */
  summary: string | null;
  /** Every other frontmatter key, in file order, for the Properties disclosure. */
  properties: MemoryDocProperty[];
  /** The body after the title. */
  blocks: MemoryDocBlock[];
  outline: MemoryOutlineEntry[];
}

/** Frontmatter keys the property line renders; `summary` is split off by `splitFrontmatter`. */
const PROPERTY_LINE_KEYS = new Set(['type', 'kind', 'date', 'status', 'tags']);
const KIND_WORDS = new Set<MemoryKind>(['experiment', 'knowledge', 'pattern']);
const KIND_BY_ID_PREFIX: Record<string, MemoryKind> = { EXP: 'experiment', K: 'knowledge', PAT: 'pattern' };

/** Lifecycle statuses and the dot they carry: green while the conclusion stands, amber while it
 *  is pending review, red once disproven, gray once something else replaced it. */
const STATUS_TONE: Record<MemoryStatusKey, MemoryStatusTone> = {
  active: 'success',
  valid: 'success',
  partial: 'success',
  corrected: 'success',
  challenged: 'amber',
  stale: 'amber',
  invalidated: 'danger',
  superseded: 'muted',
  deprecated: 'muted',
  refined: 'muted',
};

/** Headings deeper than this stay out of the outline; three levels is what a side column holds. */
const OUTLINE_MAX_LEVEL = 3;
const ANCHOR_PREFIX = 'memory-h-';

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/** `[a, "b, c", d]` → `['a', 'b, c', 'd']`; a plain scalar is a one-item list, empty is none.
 *  Commas inside quotes stay in their item (docs/memory.md asks for quoting exactly then). */
export function parseFlowList(value: string): string[] {
  const v = value.trim();
  if (!(v.startsWith('[') && v.endsWith(']'))) return v ? [unquote(v)] : [];
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of v.slice(1, -1)) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map(unquote).filter(Boolean);
}

const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const HASH_RE = /^[0-9a-f]{7,40}$/;
const PATH_RE = /^[^\s]*[\\/][^\s]*$|^[\w.-]+\.[A-Za-z0-9]{1,8}$/;

/** Ids (`EXP-001`), commit hashes and paths are things a person copies; everything else is prose. */
export function isCodeValue(value: string): boolean {
  const items = parseFlowList(value);
  return items.length > 0 && items.every((item) => ID_RE.test(item) || HASH_RE.test(item) || PATH_RE.test(item));
}

export function parseStatus(value: string | null | undefined): MemoryDocStatus | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const colon = raw.indexOf(':');
  const prefix = (colon === -1 ? raw : raw.slice(0, colon)).trim().toLowerCase();
  const ref = colon === -1 ? null : raw.slice(colon + 1).trim() || null;
  const key = prefix in STATUS_TONE ? (prefix as MemoryStatusKey) : null;
  return { key, raw, ref: key ? ref : null, tone: key ? STATUS_TONE[key] : 'muted' };
}

/** Plain text of a run of inline nodes — what an outline entry or a title reads as. */
export function inlineText(nodes: InlineNode[]): string {
  return nodes.map((node) => (node.type === 'image' ? node.alt : node.text)).join('');
}

function deriveKind(get: (key: string) => string | undefined): { kind: MemoryKind | null; kindRaw: string | null } {
  const declared = (get('type') ?? get('kind') ?? '').trim();
  if (declared) {
    const word = declared.toLowerCase() as MemoryKind;
    return KIND_WORDS.has(word) ? { kind: word, kindRaw: null } : { kind: null, kindRaw: declared };
  }
  const prefix = /^([A-Z]+)-\d+/.exec((get('id') ?? '').trim())?.[1];
  return { kind: (prefix && KIND_BY_ID_PREFIX[prefix]) || null, kindRaw: null };
}

/** `EXP-001: Fixed-protocol comparison` → `Fixed-protocol comparison` when the id is `EXP-001`. */
function stripIdPrefix(title: string, id: string | undefined): string {
  if (!id || !title.startsWith(id)) return title;
  const rest = title.slice(id.length).replace(/^[\s:：\-–—·]+/, '');
  return rest || title;
}

/**
 * Splits a memory file into the document header and body. The frontmatter is no longer one card of
 * key/value chips: kind · date · status and the tags become the property line, `summary` the lede,
 * and everything else stays reachable in a Properties list. A leading `# heading` becomes the title.
 */
export function deriveMemoryDoc(content: string): MemoryDoc {
  const { frontmatter, body } = splitFrontmatter(content);
  const entries = frontmatter?.entries ?? [];
  const get = (key: string): string | undefined => entries.find((entry) => entry.key === key)?.value;

  const parsed = parseBlocks(body);
  const first = parsed[0];
  const hasTitle = first?.type === 'heading' && first.level === 1;
  const title = hasTitle ? stripIdPrefix(inlineText(first.inline).trim(), get('id')?.trim()) : null;

  const blocks: MemoryDocBlock[] = [];
  const headings: { id: string; text: string; level: number }[] = [];
  (hasTitle ? parsed.slice(1) : parsed).forEach((block) => {
    if (block.type !== 'heading') {
      blocks.push({ block, anchor: null });
      return;
    }
    const id = `${ANCHOR_PREFIX}${headings.length}`;
    headings.push({ id, text: inlineText(block.inline).trim(), level: block.level });
    blocks.push({ block, anchor: id });
  });
  const outlined = headings.filter((heading) => heading.level <= OUTLINE_MAX_LEVEL && heading.text);
  const topLevel = Math.min(...outlined.map((heading) => heading.level));

  return {
    ...deriveKind(get),
    date: get('date')?.trim() || null,
    status: parseStatus(get('status')),
    tags: parseFlowList(get('tags') ?? ''),
    title: title || null,
    summary: frontmatter?.summary?.trim() || null,
    properties: entries
      .filter((entry) => !PROPERTY_LINE_KEYS.has(entry.key))
      .map((entry) => {
        const items = parseFlowList(entry.value);
        const isList = entry.value.trim().startsWith('[');
        return {
          key: entry.key,
          value: isList ? (items.length ? items.join(', ') : '—') : entry.value,
          code: isCodeValue(entry.value),
        };
      }),
    blocks,
    outline: outlined.map((heading) => ({ id: heading.id, text: heading.text, depth: heading.level - topLevel })),
  };
}

const NEUTRAL_CELL = /^(|—|–|-|n\/a|na|none|null|\?)$/i;
const NUMBER_PART = /^[+\-−±~≈<>]?\s*[$€£¥]?(\d[\d,_]*(\.\d+)?|\.\d+)(e[+\-−]?\d+)?\s*(%|‰|×|[a-zA-Zµ]{1,3})?$/;

/** `3/3`, `0.00957`, `97.50%`, `12 / 69 / 18`, `150 ms` read as numbers; `SGD` and `2026-10-14` do not. */
export function isNumericCell(text: string): boolean {
  const t = text.trim();
  return t !== '' && t.split('/').every((part) => NUMBER_PART.test(part.trim()));
}

/** Per column: right-align it when it has at least one number and nothing but numbers or blanks. */
export function numericColumns(header: InlineNode[][], rows: InlineNode[][][]): boolean[] {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 0);
  return Array.from({ length: columns }, (_, column) => {
    const cells = rows.map((row) => (row[column] ? inlineText(row[column]).trim() : ''));
    const filled = cells.filter((cell) => !NEUTRAL_CELL.test(cell));
    return filled.length > 0 && filled.every(isNumericCell);
  });
}

/**
 * The outline entry to highlight: the last heading scrolled to (or past) `threshold` px from the
 * top of the scroller; the first one before any has; the last one once the scroller cannot move
 * further, since a short closing section never reaches the top. A `pinned` entry — the one the
 * reader just jumped to from the outline — wins over all of that until they scroll by hand: a
 * heading near the end cannot reach the top, and neither rule would otherwise name it.
 */
export function activeOutlineId(
  tops: ReadonlyArray<{ id: string; top: number }>,
  threshold: number,
  atEnd: boolean,
  pinned: string | null = null,
): string | null {
  if (tops.length === 0) return null;
  if (pinned && tops.some((heading) => heading.id === pinned)) return pinned;
  if (atEnd) return tops[tops.length - 1].id;
  let active = tops[0].id;
  for (const heading of tops) {
    if (heading.top > threshold) break;
    active = heading.id;
  }
  return active;
}

/**
 * How far a block wider than the reading column may reach out of it on each side. `extra` is the
 * width it wants beyond the column; `left`/`right` the free room beside the column. The block
 * stays centred under the column while both sides have room and leans into whichever side has
 * more once one runs out, never past either.
 */
export function splitBleed(extra: number, left: number, right: number): { left: number; right: number } {
  const total = Math.max(0, Math.min(extra, left + right));
  const toLeft = Math.min(left, Math.max(total - right, total / 2));
  return { left: Math.floor(toLeft), right: Math.floor(total - toLeft) };
}

/** Width of the fade at a scroll box's leading / trailing edge. */
export const FADE_START_PX = 24;
export const FADE_END_PX = 44;

/**
 * Mask for a horizontally scrolling box: its trailing edge fades while more content lies beyond
 * it, its leading edge once some has scrolled out; undefined when nothing is hidden either way.
 */
export function edgeFadeMask(hiddenBefore: boolean, hiddenAfter: boolean): string | undefined {
  if (!hiddenBefore && !hiddenAfter) return undefined;
  const stops = [
    ...(hiddenBefore ? ['transparent', `#000 ${FADE_START_PX}px`] : ['#000']),
    ...(hiddenAfter ? [`#000 calc(100% - ${FADE_END_PX}px)`, 'transparent'] : ['#000']),
  ];
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
