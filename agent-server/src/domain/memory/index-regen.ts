import * as fs from 'fs';
import * as path from 'path';
import { parse as yamlParse } from 'yaml';
import { PROJECTS_DIR } from '@core/paths.js';
import { atomicWriteSync } from '@core/atomic-write.js';
import { createLogger } from '@core/log.js';

const log = createLogger('index-regen');

// The generator only ever READS the atomic EXP/K/PAT files and writes the git-ignored index.md
// next to them. Reference counts come from the access log and live only in the index: the source
// files are agent-authored, and rewriting them from here once corrupted their frontmatter while
// agents were still editing. `refs:` / `last-ref:` lines left in older files are no longer
// maintained and nothing reads them.

export const MEMORY_SUBDIRS = ['experiments', 'knowledge', 'patterns'] as const;

// --- Frontmatter ---

export type Frontmatter = Record<string, unknown>;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const KEY_LINE_RE = /^([A-Za-z_][\w-]*):(?:\s|$)/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Hand-written frontmatter is not always valid YAML (a bare `{` inside a flow list, `: ` inside a
 *  plain scalar). One bad value must not drop the whole entry from the index, so each top-level key
 *  is parsed on its own; a key that still fails keeps its raw text. */
function parseKeysLeniently(block: string): Frontmatter {
  const meta: Frontmatter = {};
  let key: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (!key) return;
    const text = lines.join('\n');
    try {
      const parsed = yamlParse(text);
      meta[key] = isPlainObject(parsed) ? parsed[key] : null;
    } catch {
      meta[key] = text.slice(key.length + 1).trim();
    }
  };
  for (const line of block.split(/\r?\n/)) {
    const match = KEY_LINE_RE.exec(line);
    if (match) {
      flush();
      key = match[1];
      lines = [line];
    } else if (key) {
      lines.push(line);
    }
  }
  flush();
  return meta;
}

/** `valid` is false when the block is not a YAML mapping and was read key by key instead. */
export function parseFrontmatter(content: string): { meta: Frontmatter; valid: boolean } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { meta: {}, valid: true };
  try {
    const parsed = yamlParse(match[1]);
    if (isPlainObject(parsed)) return { meta: parsed, valid: true };
  } catch { /* fall through to the per-key parse */ }
  return { meta: parseKeysLeniently(match[1]), valid: false };
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

// --- Access log ---

export interface RefStats {
  refs: number;
  /** ISO timestamp of the newest access, or null when never read. */
  lastRef: string | null;
}

/** Reference counts per atomic file name (`EXP-001.md`), from `<project>/_meta/access-log.jsonl`. */
export function loadRefStats(projectDir: string): Map<string, RefStats> {
  const stats = new Map<string, RefStats>();
  let content: string;
  try {
    content = fs.readFileSync(path.join(projectDir, '_meta', 'access-log.jsonl'), 'utf8');
  } catch {
    return stats;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record: { file?: unknown; ts?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.file !== 'string') continue;
    const ts = typeof record.ts === 'string' ? record.ts : null;
    const existing = stats.get(record.file);
    if (!existing) {
      stats.set(record.file, { refs: 1, lastRef: ts });
      continue;
    }
    existing.refs++;
    if (ts && (!existing.lastRef || ts > existing.lastRef)) existing.lastRef = ts;
  }
  return stats;
}

const NO_REFS: RefStats = { refs: 0, lastRef: null };

// --- Atomic files ---

export interface ParsedEntry {
  id: string;
  filename: string;
  meta: Frontmatter;
  /** False when the frontmatter is not valid YAML (parsed key by key). */
  validFrontmatter: boolean;
}

export function scanAtomicFiles(dir: string): ParsedEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const entries: ParsedEntry[] = [];
  for (const file of files) {
    if (file === 'index.md' || file.startsWith('_') || file.startsWith('.') || !file.endsWith('.md')) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const { meta, valid } = parseFrontmatter(content);
    if (meta.id === undefined || meta.id === null || meta.id === '') continue;
    if (!valid) log.warn(`${path.join(dir, file)}: frontmatter is not valid YAML, read key by key`);
    entries.push({ id: String(meta.id), filename: file, meta, validFrontmatter: valid });
  }
  return entries;
}

// Status classification for index grouping
// Active: shown in main table (active, valid, partial, corrected, challenged)
// Inactive-recoverable: superseded/deprecated/refined — conclusions replaced but not wrong
// Invalidated: proven wrong — separate section with warning
// Stale: pending review
const INVALIDATED_PREFIXES = ['invalidated'];
const INACTIVE_PREFIXES = ['superseded', 'deprecated'];
const EXCLUDED_EXACT = ['refined', 'stale']; // refined = fully replaced; stale = pending review

function statusOf(entry: ParsedEntry): string {
  const status = entry.meta.status;
  return status === undefined || status === null ? '' : String(status);
}

function isActiveStatus(status: string): boolean {
  if (!status) return true;
  const s = status.toLowerCase();
  if (INVALIDATED_PREFIXES.some(p => s.startsWith(p))) return false;
  if (INACTIVE_PREFIXES.some(p => s.startsWith(p))) return false;
  if (EXCLUDED_EXACT.includes(s)) return false;
  // challenged and corrected are still active (content updated or under review)
  return true;
}

function isInvalidatedStatus(status: string): boolean {
  return status.toLowerCase().startsWith('invalidated');
}

// --- Index generation ---

// "Use when" descriptions for each index type
const USE_WHEN: Record<string, string> = {
  experiments: 'Use when: reviewing past experiment results, checking what has been tried, or looking for related prior work before designing a new experiment.',
  knowledge: 'Use when: applying validated facts/principles to current work, checking if a question has already been answered, or verifying assumptions against established knowledge.',
  patterns: 'Use when: looking for cross-experiment regularities, anti-patterns to avoid, or established best practices before making design decisions.',
};

const HEADER_NOTE = '> Auto-generated from YAML frontmatter; Refs / Last ref come from _meta/access-log.jsonl. Do not edit manually. Not tracked by git.';

/** One markdown table cell: a value never breaks the row it sits in. */
function cell(value: unknown, max?: number): string {
  if (value === undefined || value === null) return '';
  let text = (typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/\s*\r?\n\s*/g, ' ');
  if (max !== undefined) text = text.slice(0, max);
  return text.replace(/\|/g, '\\|');
}

function text(entry: ParsedEntry, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = entry.meta[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function tagCell(entry: ParsedEntry): string {
  return stringList(entry.meta.tags).slice(0, 4).map(t => `\`${cell(t)}\``).join(', ');
}

function writeIndex(dir: string, content: string): void {
  atomicWriteSync(path.join(dir, 'index.md'), content);
}

export function generateIndex(dir: string, title: string): void {
  const entries = scanAtomicFiles(dir);
  const subdirName = path.basename(dir);
  const useWhen = USE_WHEN[subdirName] || '';
  const now = new Date().toISOString().slice(0, 19);
  const lines: string[] = [`# ${title}`, ''];
  if (useWhen) lines.push(useWhen, '');
  lines.push(HEADER_NOTE, `> Last updated: ${now}`, '');

  if (entries.length === 0) {
    lines.push('_No entries._', '');
    writeIndex(dir, lines.join('\n'));
    return;
  }

  const refStats = loadRefStats(path.dirname(dir));
  const statsOf = (e: ParsedEntry): RefStats => refStats.get(e.filename) ?? NO_REFS;
  const refsCell = (e: ParsedEntry) => `${statsOf(e).refs} | ${statsOf(e).lastRef?.slice(0, 10) ?? ''}`;

  // Three-way split: active / invalidated / inactive (superseded/deprecated/stale)
  const active = entries.filter(e => isActiveStatus(statusOf(e)));
  const invalidated = entries.filter(e => isInvalidatedStatus(statusOf(e)));
  const inactive = entries.filter(e => !isActiveStatus(statusOf(e)) && !isInvalidatedStatus(statusOf(e)));

  // Sort active by refs descending, then by date descending
  active.sort((a, b) => {
    const refDiff = statsOf(b).refs - statsOf(a).refs;
    if (refDiff !== 0) return refDiff;
    return String(b.meta.date ?? '').localeCompare(String(a.meta.date ?? ''));
  });

  // Detect type based on ID prefix
  const isExperiments = entries.some(e => e.id.startsWith('EXP-'));
  const isKnowledge = entries.some(e => e.id.startsWith('K-'));

  lines.push(`## Active (${active.length} entries)`, '');
  if (isExperiments) {
    lines.push('| ID | Date | Summary | Tags | Refs | Last ref | Links |');
    lines.push('|----|------|---------|------|------|----------|-------|');
    for (const e of active) {
      const links = stringList(e.meta.links).map(l => cell(l)).join(', ');
      lines.push(`| ${cell(e.id)} | ${cell(e.meta.date)} | ${cell(text(e, 'summary') ?? '—', 100)} | ${tagCell(e)} | ${refsCell(e)} | ${links} |`);
    }
  } else if (isKnowledge) {
    lines.push('| ID | Title | Source | Refs | Last ref |');
    lines.push('|----|-------|--------|------|----------|');
    for (const e of active) {
      lines.push(`| ${cell(e.id)} | ${cell(text(e, 'title', 'summary') ?? '—')} | ${cell(e.meta.source)} | ${refsCell(e)} |`);
    }
  } else {
    // Generic (patterns, etc)
    lines.push('| ID | Summary | Tags | Sources | Refs | Last ref |');
    lines.push('|----|---------|------|---------|------|----------|');
    for (const e of active) {
      const sources = stringList(e.meta['source-experiments']).map(s => cell(s)).join(', ');
      lines.push(`| ${cell(e.id)} | ${cell(text(e, 'summary', 'title') ?? '—')} | ${tagCell(e)} | ${sources} | ${refsCell(e)} |`);
    }
  }

  // Invalidated section — prominent warning
  if (invalidated.length > 0) {
    lines.push('', `## Invalidated (${invalidated.length} entries)`, '');
    lines.push('> These entries have been proven wrong. Do NOT use their conclusions. Kept for audit trail only.');
    lines.push('');
    lines.push('| ID | Date | Summary | Invalidated By | Refs |');
    lines.push('|----|------|---------|----------------|------|');
    for (const e of invalidated) {
      const statusTarget = statusOf(e).replace(/^invalidated:/i, '').trim();
      lines.push(`| ${cell(e.id)} | ${cell(e.meta.date)} | ${cell(text(e, 'summary', 'title') ?? '—', 80)} | ${cell(statusTarget)} | ${statsOf(e).refs} |`);
    }
  }

  // Superseded/Deprecated section
  if (inactive.length > 0) {
    lines.push('', `## Superseded / Deprecated (${inactive.length} entries)`, '');
    lines.push('| ID | Date | Summary | Status | Refs |');
    lines.push('|----|------|---------|--------|------|');
    for (const e of inactive) {
      lines.push(`| ${cell(e.id)} | ${cell(e.meta.date)} | ${cell(text(e, 'summary', 'title') ?? '—', 80)} | ${cell(statusOf(e))} | ${statsOf(e).refs} |`);
    }
  }

  // Stats
  const hotThreshold = 5;
  const coldAgeDays = 14;
  const today = Date.now();
  const hot = active.filter(e => statsOf(e).refs >= hotThreshold).map(e => e.id);
  const cold = active
    .filter(e => {
      if (statsOf(e).refs > 0) return false;
      const d = e.meta.date ? new Date(String(e.meta.date)) : null;
      if (!d || isNaN(d.getTime())) return false;
      return (today - d.getTime()) / 86400000 > coldAgeDays;
    })
    .map(e => e.id);
  const challenged = active.filter(e => statusOf(e).toLowerCase().startsWith('challenged'));
  const invalidYaml = entries.filter(e => !e.validFrontmatter);

  lines.push('', '## Stats');
  lines.push(`- Total: ${entries.length} (${active.length} active, ${invalidated.length} invalidated, ${inactive.length} superseded/deprecated)`);
  if (challenged.length > 0) {
    lines.push(`- Challenged (under review): ${challenged.map(e => e.id).join(', ')}`);
  }
  lines.push(`- Hot (refs >= ${hotThreshold}): ${hot.slice(0, 10).join(', ') || 'none'}`);
  lines.push(`- Cold (refs=0, age>${coldAgeDays}d): ${cold.slice(0, 10).join(', ') || 'none'}`);
  if (invalidYaml.length > 0) {
    lines.push(`- Invalid YAML frontmatter (fix the file): ${invalidYaml.map(e => e.filename).join(', ')}`);
  }
  lines.push('');

  writeIndex(dir, lines.join('\n'));
}

// --- Projects ---

function hasMemoryDirs(projectDir: string): boolean {
  return MEMORY_SUBDIRS.some(sub => fs.existsSync(path.join(projectDir, sub)));
}

/** Projects that have at least one memory directory, sorted. */
export function listMemoryProjects(): string[] {
  // withFileTypes avoids ENOENT on broken symlinks (e.g. AGENTS.md -> CLAUDE.md)
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .filter(name => hasMemoryDirs(path.join(PROJECTS_DIR, name)))
    .sort();
}

export function regenAll(): string[] {
  const projects = listMemoryProjects();
  for (const p of projects) regenProject(p);
  return projects;
}

/** Regenerate every index of one project. Returns the regenerated index paths, relative to the
 *  project directory; empty when the project does not exist. */
export function regenProject(projectName: string): string[] {
  const projectDir = path.join(PROJECTS_DIR, projectName);
  if (!fs.existsSync(projectDir)) {
    log.error(`Project not found: ${projectName}`);
    return [];
  }
  const written: string[] = [];
  for (const subdir of MEMORY_SUBDIRS) {
    const dir = path.join(projectDir, subdir);
    if (!fs.existsSync(dir)) continue;
    const ucFirst = subdir.charAt(0).toUpperCase() + subdir.slice(1);
    generateIndex(dir, `${ucFirst} Index — ${projectName}`);
    written.push(`${subdir}/index.md`);
  }
  return written;
}
