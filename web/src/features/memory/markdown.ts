// input:  Markdown source and optional math parsing mode
// output: Frontmatter, block, and inline AST nodes
// pos:    Pure Markdown parser shared by memory and chat views
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export interface FrontmatterEntry {
  key: string;
  value: string;
}

export interface Frontmatter {
  /** Non-`summary` key/value pairs, in file order — rendered as the card's chips. */
  entries: FrontmatterEntry[];
  /** The `summary` key value if present (rendered as the card's summary line), else null. */
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
  | { type: 'link'; text: string; href: string };

export type Block =
  | { type: 'heading'; level: number; inline: InlineNode[] }
  | { type: 'paragraph'; inline: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] }
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
 * Only top-level `key: value` lines are parsed (the memory card renders flat chips); the `summary`
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

const INLINE_RE = /(?<bold>\*\*[^*]+\*\*)|(?<code>(?<ticks>`+)(?<codeText>.*?)\k<ticks>)|(?<link>\[(?<linkText>[^\]]+)\]\((?<href>[^)]+)\))|(?<italicStar>\*[^*]+\*)|(?<italicUnderscore>_[^_]+_)/;
const INLINE_KINDS = ['bold', 'code', 'link', 'italicStar', 'italicUnderscore'] as const;

type InlineKind = (typeof INLINE_KINDS)[number];
type InlineGroups = Record<string, string | undefined>;
type InlineFactory = (groups: InlineGroups) => InlineNode;
interface InlineSpan { index: number; length: number; node: InlineNode }

const INLINE_FACTORIES: Record<InlineKind, InlineFactory> = {
  bold: (groups) => ({ type: 'bold', text: groups.bold!.slice(2, -2) }),
  code: (groups) => ({ type: 'code', text: groups.codeText! }),
  link: (groups) => ({ type: 'link', text: groups.linkText!, href: groups.href! }),
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

function splitCells(row: string): string[] {
  let value = row.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
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

function readList(lines: string[], index: number, options: ParseOptions): BlockRead | null {
  if (!isListLine(lines[index])) return null;
  const ordered = /^\s*\d+\.\s+/.test(lines[index]);
  const items: InlineNode[][] = [];
  let cursor = index;
  while (cursor < lines.length && isListLine(lines[cursor])) {
    const text = lines[cursor].replace(/^\s*([-*+]|\d+\.)\s+/, '');
    items.push(parseInline(text.trim(), options));
    cursor++;
  }
  return { block: { type: 'list', ordered, items }, next: cursor };
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
