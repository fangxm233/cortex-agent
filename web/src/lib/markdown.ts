export interface FrontmatterEntry {
  key: string;
  value: string;
}

export interface Frontmatter {
  /** Non-`summary` key/value pairs, in file order — the memory viewer's property line and Properties list. */
  entries: FrontmatterEntry[];
  /** The `summary` key value if present (the memory viewer's lede), else null. */
  summary: string | null;
}

export interface ParseOptions {
  math?: boolean;
}

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'math'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'image'; alt: string; src: string };

export type Block =
  | { type: 'heading'; level: number; inline: InlineNode[] }
  | { type: 'paragraph'; inline: InlineNode[] }
  /** Each item is its own run of blocks: its text, plus any continuation paragraphs, code or sublists. */
  | { type: 'list'; ordered: boolean; start?: number; items: Block[][] }
  | { type: 'code'; lang: string | null; text: string }
  | { type: 'math'; text: string }
  | { type: 'table'; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: 'blockquote'; inline: InlineNode[] }
  | { type: 'hr' };

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Splits a YAML `--- … ---` frontmatter fence off the top of a Markdown file. Returns null
 * frontmatter (and the untouched source as body) when there is no well-formed leading fence.
 * Only top-level `key: value` lines are parsed (the memory viewer shows flat values); the `summary`
 * key is surfaced separately.
 */
export function splitFrontmatter(content: string): { frontmatter: Frontmatter | null; body: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { frontmatter: null, body: content };

  const rest = normalized.slice(4);
  const closeIdx = rest.search(/\n---[ \t]*(\n|$)/);
  if (closeIdx === -1) return { frontmatter: null, body: content };

  const yaml = rest.slice(0, closeIdx);
  const afterClose = rest.slice(closeIdx + 1); // includes the "---" line
  const bodyStart = afterClose.indexOf('\n');
  const body = bodyStart === -1 ? '' : afterClose.slice(bodyStart + 1);

  const entries: FrontmatterEntry[] = [];
  let summary: string | null = null;
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = stripQuotes(m[2].trim());
    if (key === 'summary') {
      summary = value;
      continue;
    }
    entries.push({ key, value });
  }
  return { frontmatter: { entries, summary }, body };
}

/** A link or image target: any run without parentheses, plus balanced pairs nested up to two deep,
 *  so `https://en.wikipedia.org/wiki/Rust_(programming_language)` stays whole. */
const TARGET = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))+`;
const INLINE_RE = new RegExp([
  String.raw`(?<bold>\*\*[^*]+\*\*)`,
  String.raw`(?<code>(?<ticks>\x60+)(?<codeText>.*?)\k<ticks>)`,
  String.raw`(?<image>!\[(?<alt>[^\]]*)\]\((?<src>${TARGET})\))`,
  String.raw`(?<link>\[(?<linkText>[^\]]+)\]\((?<href>${TARGET})\))`,
  String.raw`(?<italicStar>\*[^*]+\*)`,
  String.raw`(?<italicUnderscore>_[^_]+_)`,
].join('|'));
const INLINE_KINDS = ['bold', 'code', 'image', 'link', 'italicStar', 'italicUnderscore'] as const;

type InlineKind = (typeof INLINE_KINDS)[number];
type InlineGroups = Record<string, string | undefined>;
type InlineFactory = (groups: InlineGroups) => InlineNode;
interface InlineSpan { index: number; length: number; node: InlineNode }

const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);
const NAMED_URL_ENTITIES: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', nbsp: ' ' };

function decodeUrlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, body: string) => {
    if (body[0] !== '#') return NAMED_URL_ENTITIES[body.toLowerCase()] ?? match;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/**
 * The href a Markdown link may carry, or null when it must render as plain text. Markdown here is
 * untrusted (model output, workspace files), so only http(s), mailto and scheme-less references
 * (relative paths, `#anchors`, `?query`, `//host`) pass. The scheme is read the way a browser would
 * find one, and then some: entities decoded and every whitespace/control character dropped, so
 * `java&#x09;script:` or ` JaVaScRiPt:` cannot slip through as a "relative" link.
 */
export function safeLinkHref(href: string): string | null {
  const normalized = decodeUrlEntities(href).replace(/[\u0000- \u007f-\u009f\s]+/g, '');
  const scheme = /^([^/?#]*?):/.exec(normalized);
  if (scheme && !SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return href.trim();
}

function linkNode(text: string, rawHref: string): InlineNode {
  const href = safeLinkHref(rawHref);
  return href === null ? { type: 'text', text } : { type: 'link', text, href };
}

const INLINE_FACTORIES: Record<InlineKind, InlineFactory> = {
  bold: (groups) => ({ type: 'bold', text: groups.bold!.slice(2, -2) }),
  code: (groups) => ({ type: 'code', text: groups.codeText! }),
  image: (groups) => ({ type: 'image', alt: groups.alt ?? '', src: groups.src! }),
  link: (groups) => linkNode(groups.linkText!, groups.href!),
  italicStar: (groups) => ({ type: 'italic', text: groups.italicStar!.slice(1, -1) }),
  italicUnderscore: (groups) => ({ type: 'italic', text: groups.italicUnderscore!.slice(1, -1) }),
};

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function findClosingDollar(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === '`' && !isEscaped(text, index)) return -1;
    const previous = text[index - 1];
    const next = text[index + 1] ?? '';
    const adjacentDollar = previous === '$' || next === '$';
    if (text[index] === '$' && !adjacentDollar && !isEscaped(text, index) && !/\s/.test(previous) && !/^\d$/.test(next)) return index;
  }
  return -1;
}

function findDollarMath(text: string): InlineSpan | null {
  for (let open = text.indexOf('$'); open >= 0; open = text.indexOf('$', open + 1)) {
    const previous = text[open - 1] ?? '';
    const next = text[open + 1] ?? '';
    if (isEscaped(text, open) || previous === '$' || !next || /[\s$\d]/.test(next)) continue;
    const close = findClosingDollar(text, open);
    if (close > open + 1) return { index: open, length: close - open + 1, node: { type: 'math', text: text.slice(open + 1, close) } };
  }
  return null;
}

function findParenMath(text: string): InlineSpan | null {
  for (let open = text.indexOf('\\('); open >= 0; open = text.indexOf('\\(', open + 2)) {
    if (isEscaped(text, open)) continue;
    for (let close = text.indexOf('\\)', open + 2); close >= 0; close = text.indexOf('\\)', close + 2)) {
      if (!isEscaped(text, close)) return { index: open, length: close - open + 2, node: { type: 'math', text: text.slice(open + 2, close) } };
    }
  }
  return null;
}

function earlierSpan(first: InlineSpan | null, second: InlineSpan | null): InlineSpan | null {
  if (!first) return second;
  if (!second) return first;
  return first.index <= second.index ? first : second;
}

function nextMathSpan(text: string): InlineSpan | null {
  return earlierSpan(findDollarMath(text), findParenMath(text));
}

function nextMarkdownSpan(text: string): InlineSpan | null {
  const match = INLINE_RE.exec(text);
  if (!match) return null;
  const groups = match.groups as InlineGroups;
  const kind = INLINE_KINDS.find((candidate) => groups[candidate] != null);
  const node = kind ? INLINE_FACTORIES[kind](groups) : { type: 'text' as const, text: match[0] };
  return { index: match.index, length: match[0].length, node };
}

function appendInline(nodes: InlineNode[], node: InlineNode): void {
  const previous = nodes[nodes.length - 1];
  if (node.type === 'text' && previous?.type === 'text') previous.text += node.text;
  else nodes.push(node);
}

/** Tokenizes a line into non-nesting Markdown spans and optional math. */
export function parseInline(text: string, options: ParseOptions = {}): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = text;
  while (rest.length) {
    const math = options.math ? nextMathSpan(rest) : null;
    const span = earlierSpan(math, nextMarkdownSpan(rest));
    if (!span) {
      appendInline(nodes, { type: 'text', text: rest });
      break;
    }
    if (span.index > 0) appendInline(nodes, { type: 'text', text: rest.slice(0, span.index) });
    appendInline(nodes, span.node);
    rest = rest.slice(span.index + span.length);
  }
  return nodes.length ? nodes : [{ type: 'text', text: '' }];
}

/** Cuts a row at its pipes. As in GFM, `\|` is a literal pipe inside the cell, not a boundary:
 *  that is how a cell holds `|x|` or `kt\|v_t\|`, in code and math too. */
function scanCells(value: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && value[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (value[i] === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += value[i];
    }
  }
  cells.push(cell);
  return cells;
}

/** A leading or trailing pipe opens or closes the row rather than bounding an empty cell. */
function splitCells(row: string): string[] {
  const value = row.trim();
  const cells = scanCells(value);
  if (value.startsWith('|')) cells.shift();
  if (value.endsWith('|') && !value.endsWith('\\|')) cells.pop();
  return cells.map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

function isListLine(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

interface BlockRead {
  block: Block;
  next: number;
}

type BlockReader = (lines: string[], index: number, options: ParseOptions) => BlockRead | null;

interface CodeFence {
  marker: '`' | '~';
  length: number;
  lang: string | null;
}

function openingCodeFence(line: string): CodeFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[1][0] as CodeFence['marker'];
  const info = match[2].trim();
  if (marker === '`' && info.includes('`')) return null;
  return { marker, length: match[1].length, lang: info.split(/\s+/, 1)[0] || null };
}

function closesCodeFence(line: string, fence: CodeFence): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && [...trimmed].every((character) => character === fence.marker);
}

function readFencedCode(lines: string[], index: number): BlockRead | null {
  const fence = openingCodeFence(lines[index]);
  if (!fence) return null;
  const buffer: string[] = [];
  let cursor = index + 1;
  while (cursor < lines.length && !closesCodeFence(lines[cursor], fence)) buffer.push(lines[cursor++]);
  const next = cursor < lines.length ? cursor + 1 : cursor;
  return { block: { type: 'code', lang: fence.lang, text: buffer.join('\n') }, next };
}

const DISPLAY_DELIMITERS = [
  { open: '$$', close: '$$' },
  { open: '\\[', close: '\\]' },
] as const;

function readDisplayMath(lines: string[], index: number, options: ParseOptions): BlockRead | null {
  if (!options.math) return null;
  const openingLine = lines[index].trim();
  const delimiter = DISPLAY_DELIMITERS.find(({ open }) => openingLine.startsWith(open));
  if (!delimiter) return null;
  const first = openingLine.slice(delimiter.open.length);
  if (first.endsWith(delimiter.close)) {
    return { block: { type: 'math', text: first.slice(0, -delimiter.close.length).trim() }, next: index + 1 };
  }
  if (first) return null;
  const buffer: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    if (lines[cursor].trim() !== delimiter.close) {
      buffer.push(lines[cursor]);
      continue;
    }
    return { block: { type: 'math', text: buffer.join('\n').trim() }, next: cursor + 1 };
  }
  return null;
}

function readHeading(lines: string[], index: number, options: ParseOptions): BlockRead | null {
  const heading = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
  if (!heading) return null;
  return {
    block: { type: 'heading', level: heading[1].length, inline: parseInline(heading[2].trim(), options) },
    next: index + 1,
  };
}

function readHorizontalRule(lines: string[], index: number): BlockRead | null {
  if (!/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])) return null;
  return { block: { type: 'hr' }, next: index + 1 };
}

function parseCells(row: string, options: ParseOptions): InlineNode[][] {
  return splitCells(row).map((cell) => parseInline(cell, options));
}

function readTable(lines: string[], index: number, options: ParseOptions): BlockRead | null {
  if (!lines[index].includes('|') || index + 1 >= lines.length || !isTableSeparator(lines[index + 1])) return null;
  const rows: InlineNode[][][] = [];
  let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
    rows.push(parseCells(lines[cursor], options));
    cursor++;
  }
  return { block: { type: 'table', header: parseCells(lines[index], options), rows }, next: cursor };
}

function readBlockquote(lines: string[], index: number, options: ParseOptions): BlockRead | null {
  if (!/^>\s?/.test(lines[index])) return null;
  const buffer: string[] = [];
  let cursor = index;
  while (cursor < lines.length && /^>\s?/.test(lines[cursor])) {
    buffer.push(lines[cursor].replace(/^>\s?/, ''));
    cursor++;
  }
  return { block: { type: 'blockquote', inline: parseInline(buffer.join(' ').trim(), options) }, next: cursor };
}

interface ListMarker {
  indent: number;
  ordered: boolean;
  start: number;
  /** Column where the item's text begins; continuation lines are dedented up to it. */
  content: number;
}

function listMarker(line: string): ListMarker | null {
  const match = /^(\s*)([-*+]|(\d+)\.)\s+/.exec(line);
  if (!match) return null;
  return { indent: match[1].length, ordered: match[3] !== undefined, start: Number(match[3] ?? 1), content: match[0].length };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function skipBlankLines(lines: string[], from: number): number {
  let cursor = from;
  while (cursor < lines.length && !lines[cursor].trim()) cursor++;
  return cursor;
}

/** A line continues the open item when it is indented past the marker, or — straight after item
 *  text, with no blank line between — when it starts no block of its own (a lazy continuation). */
function continuesItem(lines: string[], index: number, marker: ListMarker, afterBlank: boolean, options: ParseOptions): boolean {
  if (indentOf(lines[index]) > marker.indent) return true;
  if (afterBlank || isListLine(lines[index])) return false;
  return readStructuredBlock(lines, index, options) === null;
}

/** One item's source, dedented to its text column, and the index just past its last line. */
function readListItem(lines: string[], index: number, marker: ListMarker, options: ParseOptions): { body: string[]; next: number } {
  const body = [lines[index].slice(marker.content)];
  let cursor = index + 1;
  for (let line = skipBlankLines(lines, cursor); line < lines.length; line = skipBlankLines(lines, cursor)) {
    if (!continuesItem(lines, line, marker, line > cursor, options)) break;
    body.push(...Array<string>(line - cursor).fill(''), lines[line].slice(Math.min(indentOf(lines[line]), marker.content)));
    cursor = line + 1;
  }
  return { body, next: cursor };
}

/** The next sibling item's marker and line, across blank lines; null once the list ends. */
function nextSibling(lines: string[], from: number, ordered: boolean): { marker: ListMarker; index: number } | null {
  const index = skipBlankLines(lines, from);
  const marker = index < lines.length ? listMarker(lines[index]) : null;
  return marker && marker.ordered === ordered ? { marker, index } : null;
}

function readList(lines: string[], index: number, options: ParseOptions): BlockRead | null {
  const first = listMarker(lines[index]);
  if (!first) return null;
  const items: Block[][] = [];
  let item: { marker: ListMarker; index: number } | null = { marker: first, index };
  let end = index;
  while (item) {
    const read = readListItem(lines, item.index, item.marker, options);
    items.push(parseBlocks(read.body.join('\n'), options));
    end = read.next;
    item = nextSibling(lines, end, first.ordered);
  }
  const start = first.ordered ? { start: first.start } : {};
  return { block: { type: 'list', ordered: first.ordered, ...start, items }, next: end };
}

const BLOCK_READERS: BlockReader[] = [
  readFencedCode,
  readDisplayMath,
  readHeading,
  readHorizontalRule,
  readTable,
  readBlockquote,
  readList,
];

function readStructuredBlock(lines: string[], index: number, options: ParseOptions): BlockRead | null {
  for (const reader of BLOCK_READERS) {
    const result = reader(lines, index, options);
    if (result) return result;
  }
  return null;
}

function readParagraph(lines: string[], index: number, options: ParseOptions): BlockRead {
  const buffer: string[] = [];
  let cursor = index;
  while (cursor < lines.length && lines[cursor].trim()) {
    if (cursor > index && readStructuredBlock(lines, cursor, options)) break;
    buffer.push(lines[cursor].trim());
    cursor++;
  }
  return { block: { type: 'paragraph', inline: parseInline(buffer.join(' '), options) }, next: cursor };
}

/** Parses a Markdown body (frontmatter already stripped) into block nodes. */
export function parseBlocks(body: string, options: ParseOptions = {}): Block[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    const result = readStructuredBlock(lines, index, options) ?? readParagraph(lines, index, options);
    blocks.push(result.block);
    index = result.next;
  }
  return blocks;
}
