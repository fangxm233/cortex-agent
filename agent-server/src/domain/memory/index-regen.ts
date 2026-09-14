import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR, isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';

const log = createLogger('index-regen');

// --- Frontmatter parser ---

interface Frontmatter {
  [key: string]: string | string[] | number | null;
}

function parseFrontmatter(content: string): { meta: Frontmatter; body: string; raw: string } {
  // Normalize \r\n → \n to handle Windows-edited files
  const normalized = content.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: content, raw: '' };
  }
  const endMarker = normalized.indexOf('\n---\n', 4);
  if (endMarker === -1) return { meta: {}, body: content, raw: '' };

  const yamlBlock = normalized.slice(4, endMarker);
  const body = normalized.slice(endMarker + 5);
  const meta: Frontmatter = {};

  const lines = yamlBlock.split('\n');
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(/^([\w][\w-]*):\s*(.*)/);
    if (!match) { i++; continue; }
    const [, key, rawVal] = match;
    const trimmed = rawVal.trim();

    // Multi-line block scalar: | or >
    if (trimmed === '|' || trimmed === '>') {
      const joinChar = trimmed === '|' ? '\n' : ' ';
      const blockLines: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        blockLines.push(lines[i].startsWith('  ') ? lines[i].slice(2) : '');
        i++;
      }
      // Trim trailing empty lines
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') blockLines.pop();
      meta[key] = blockLines.join(joinChar);
      continue;
    }

    meta[key] = parseSimpleYamlValue(trimmed);
    i++;
  }

  return { meta, body, raw: yamlBlock };
}

function parseSimpleYamlValue(s: string): string | string[] | number | null {
  if (s === 'null') return null;
  // Array: [item1, item2]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1);
    if (inner.trim() === '') return [];
    return inner.split(',').map(item => {
      let v = item.trim();
      // Strip quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    });
  }
  // Number
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  return s;
}

function serializeFrontmatter(meta: Frontmatter): string {
  const lines = ['---'];
  for (const [key, val] of Object.entries(meta)) {
    if (val === null) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(val)) {
      const items = val.map(v => {
        if (/[,\[\]:"']/.test(v) || v.includes(' ')) return `"${v}"`;
        return v;
      });
      lines.push(`${key}: [${items.join(', ')}]`);
    } else if (typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else {
      // String - quote if needed
      const s = String(val);
      if (/[:"'\[\]{}#|>&*!?,\n]/.test(s) || s.startsWith(' ') || s.startsWith('-')) {
        lines.push(`${key}: "${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${key}: ${s}`);
      }
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// --- Access log parser ---

interface AccessRecord {
  file: string;
  ts: string;
}

function loadAccessLog(metaDir: string): Map<string, { count: number; lastRef: string | null }> {
  const logPath = path.join(metaDir, 'access-log.jsonl');
  const stats = new Map<string, { count: number; lastRef: string | null }>();

  if (!fs.existsSync(logPath)) return stats;

  const content = fs.readFileSync(logPath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record: AccessRecord = JSON.parse(line);
      const existing = stats.get(record.file);
      if (existing) {
        existing.count++;
        if (!existing.lastRef || record.ts > existing.lastRef) {
          existing.lastRef = record.ts;
        }
      } else {
        stats.set(record.file, { count: 1, lastRef: record.ts });
      }
    } catch {
      // skip malformed lines
    }
  }
  return stats;
}

// --- Index generation ---

interface ParsedEntry {
  id: string;
  filename: string;
  meta: Frontmatter;
}

function scanAtomicFiles(dir: string): ParsedEntry[] {
  if (!fs.existsSync(dir)) return [];

  const entries: ParsedEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (file === 'index.md' || file === '_section-mapping.md' || file.startsWith('_') || file.startsWith('.')) continue;
    if (!file.endsWith('.md')) continue;

    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    const { meta } = parseFrontmatter(content);
    if (!meta.id) continue;

    entries.push({ id: String(meta.id), filename: file, meta });
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

function isActiveStatus(status: string | null | undefined): boolean {
  if (!status) return true;
  const s = String(status).toLowerCase();
  if (INVALIDATED_PREFIXES.some(p => s.startsWith(p))) return false;
  if (INACTIVE_PREFIXES.some(p => s.startsWith(p))) return false;
  if (EXCLUDED_EXACT.includes(s)) return false;
  // challenged and corrected are still active (content updated or under review)
  return true;
}

function isInvalidatedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return String(status).toLowerCase().startsWith('invalidated');
}

// "Use when" descriptions for each index type
const USE_WHEN: Record<string, string> = {
  experiments: 'Use when: reviewing past experiment results, checking what has been tried, or looking for related prior work before designing a new experiment.',
  knowledge: 'Use when: applying validated facts/principles to current work, checking if a question has already been answered, or verifying assumptions against established knowledge.',
  patterns: 'Use when: looking for cross-experiment regularities, anti-patterns to avoid, or established best practices before making design decisions.',
};

function generateIndex(dir: string, title: string): void {
  const entries = scanAtomicFiles(dir);
  const subdirName = path.basename(dir);

  if (entries.length === 0) {
    const useWhen = USE_WHEN[subdirName] || '';
    const empty = `# ${title}\n\n${useWhen ? useWhen + '\n\n' : ''}> Auto-generated from frontmatter. Do not edit manually.\n> Last updated: ${new Date().toISOString().slice(0, 19)}\n\n_No entries._\n`;
    fs.writeFileSync(path.join(dir, 'index.md'), empty);
    return;
  }

  // Load access stats from _meta/
  const projectDir = path.dirname(dir);
  const metaDir = path.join(projectDir, '_meta');
  const accessStats = loadAccessLog(metaDir);

  // Update refs in each file's frontmatter
  for (const entry of entries) {
    const basename = entry.filename;
    const stats = accessStats.get(basename);
    const newRefs = stats ? stats.count : 0;
    const newLastRef = stats ? stats.lastRef : null;

    const currentRefs = entry.meta.refs;
    const currentLastRef = entry.meta['last-ref'];

    if (currentRefs !== newRefs || currentLastRef !== newLastRef) {
      entry.meta.refs = newRefs;
      entry.meta['last-ref'] = newLastRef;

      // Rewrite file with updated frontmatter
      const filePath = path.join(dir, basename);
      const content = fs.readFileSync(filePath, 'utf8');
      const { body } = parseFrontmatter(content);
      fs.writeFileSync(filePath, serializeFrontmatter(entry.meta) + '\n' + body);
    }
  }

  // Three-way split: active / invalidated / inactive (superseded/deprecated/stale)
  const active = entries.filter(e => isActiveStatus(e.meta.status as string));
  const invalidated = entries.filter(e => isInvalidatedStatus(e.meta.status as string));
  const inactive = entries.filter(e =>
    !isActiveStatus(e.meta.status as string) && !isInvalidatedStatus(e.meta.status as string));

  // Sort active by refs descending, then by date descending
  active.sort((a, b) => {
    const refsA = typeof a.meta.refs === 'number' ? a.meta.refs : 0;
    const refsB = typeof b.meta.refs === 'number' ? b.meta.refs : 0;
    if (refsB !== refsA) return refsB - refsA;
    const dateA = String(a.meta.date || '');
    const dateB = String(b.meta.date || '');
    return dateB.localeCompare(dateA);
  });

  // Build index content
  const now = new Date().toISOString().slice(0, 19);
  const useWhen = USE_WHEN[subdirName] || '';
  const lines: string[] = [
    `# ${title}`,
    '',
  ];
  if (useWhen) lines.push(useWhen, '');
  lines.push(
    `> Auto-generated by memory-index-regen.ts from YAML frontmatter. Do not edit manually. Not tracked by git.`,
    `> Last updated: ${now}`,
    '',
  );

  // Detect type based on ID prefix
  const isExperiments = entries.some(e => String(e.meta.id).startsWith('EXP-'));
  const isKnowledge = entries.some(e => String(e.meta.id).startsWith('K-'));

  if (isExperiments) {
    lines.push(`## Active (${active.length} entries)`, '');
    lines.push('| ID | Date | Summary | Tags | Refs | Links |');
    lines.push('|----|------|---------|------|------|-------|');
    for (const e of active) {
      const tags = Array.isArray(e.meta.tags)
        ? (e.meta.tags as string[]).slice(0, 4).map(t => `\`${t}\``).join(', ')
        : '';
      const links = Array.isArray(e.meta.links) ? (e.meta.links as string[]).join(', ') : '';
      const summary = String(e.meta.summary || '—').slice(0, 100);
      lines.push(`| ${e.meta.id} | ${e.meta.date || ''} | ${summary} | ${tags} | ${e.meta.refs || 0} | ${links} |`);
    }
  } else if (isKnowledge) {
    lines.push(`## Active (${active.length} entries)`, '');
    lines.push('| ID | Title | Source | Refs |');
    lines.push('|----|-------|--------|------|');
    for (const e of active) {
      lines.push(`| ${e.meta.id} | ${e.meta.title || e.meta.summary || '—'} | ${e.meta.source || ''} | ${e.meta.refs || 0} |`);
    }
  } else {
    // Generic (patterns, etc)
    lines.push(`## Active (${active.length} entries)`, '');
    lines.push('| ID | Summary | Tags | Sources | Refs |');
    lines.push('|----|---------|------|---------|------|');
    for (const e of active) {
      const tags = Array.isArray(e.meta.tags)
        ? (e.meta.tags as string[]).slice(0, 4).map(t => `\`${t}\``).join(', ')
        : '';
      const sources = Array.isArray(e.meta['source-experiments'])
        ? (e.meta['source-experiments'] as string[]).join(', ')
        : '';
      lines.push(`| ${e.meta.id} | ${e.meta.summary || e.meta.title || '—'} | ${tags} | ${sources} | ${e.meta.refs || 0} |`);
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
      const summary = String(e.meta.summary || e.meta.title || '—').slice(0, 80);
      const statusTarget = String(e.meta.status || '').replace(/^invalidated:/i, '').trim();
      lines.push(`| ${e.meta.id} | ${e.meta.date || ''} | ${summary} | ${statusTarget} | ${e.meta.refs || 0} |`);
    }
  }

  // Superseded/Deprecated section
  if (inactive.length > 0) {
    lines.push('', `## Superseded / Deprecated (${inactive.length} entries)`, '');
    lines.push('| ID | Date | Summary | Status | Refs |');
    lines.push('|----|------|---------|--------|------|');
    for (const e of inactive) {
      const summary = String(e.meta.summary || e.meta.title || '—').slice(0, 80);
      lines.push(`| ${e.meta.id} | ${e.meta.date || ''} | ${summary} | ${e.meta.status || ''} | ${e.meta.refs || 0} |`);
    }
  }

  // Stats
  const hotThreshold = 5;
  const coldAgeDays = 14;
  const today = new Date();
  const hot = active
    .filter(e => typeof e.meta.refs === 'number' && e.meta.refs >= hotThreshold)
    .map(e => String(e.meta.id));
  const cold = active
    .filter(e => {
      if (typeof e.meta.refs === 'number' && e.meta.refs > 0) return false;
      const d = e.meta.date ? new Date(String(e.meta.date)) : null;
      if (!d || isNaN(d.getTime())) return false;
      return (today.getTime() - d.getTime()) / 86400000 > coldAgeDays;
    })
    .map(e => String(e.meta.id));

  // Count challenged entries in active
  const challenged = active.filter(e => String(e.meta.status || '').toLowerCase().startsWith('challenged'));

  lines.push('', '## Stats');
  lines.push(`- Total: ${entries.length} (${active.length} active, ${invalidated.length} invalidated, ${inactive.length} superseded/deprecated)`);
  if (challenged.length > 0) {
    lines.push(`- Challenged (under review): ${challenged.map(e => String(e.meta.id)).join(', ')}`);
  }
  lines.push(`- Hot (refs >= ${hotThreshold}): ${hot.slice(0, 10).join(', ') || 'none'}`);
  lines.push(`- Cold (refs=0, age>${coldAgeDays}d): ${cold.slice(0, 10).join(', ') || 'none'}`);
  lines.push('');

  fs.writeFileSync(path.join(dir, 'index.md'), lines.join('\n'));
}

// --- CLI: regenerate indexes for all or specific projects ---

export function regenAll(): string[] {
  // Use withFileTypes to avoid ENOENT on broken symlinks (e.g. AGENTS.md -> CLAUDE.md)
  const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .filter(d => {
      const dir = path.join(PROJECTS_DIR, d);
      return fs.existsSync(path.join(dir, 'experiments'))
        || fs.existsSync(path.join(dir, 'knowledge'))
        || fs.existsSync(path.join(dir, 'patterns'));
    });
  for (const p of projects) {
    regenProject(p);
  }
  return projects;
}

export function regenProject(projectName: string): void {
  const projectDir = path.join(PROJECTS_DIR, projectName);
  if (!fs.existsSync(projectDir)) {
    log.error(`Project not found: ${projectName}`);
    return;
  }

  log.info(`Regenerating indexes for ${projectName}...`);

  for (const subdir of ['experiments', 'knowledge', 'patterns']) {
    const dir = path.join(projectDir, subdir);
    if (fs.existsSync(dir)) {
      const ucFirst = subdir.charAt(0).toUpperCase() + subdir.slice(1);
      generateIndex(dir, `${ucFirst} Index — ${projectName}`);
      log.info(`  ${subdir}/index.md`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    log.info(`Usage: memory-index-regen.ts [--all | <project-name> ... | <directory-path>]

Regenerate index.md from atomic file frontmatter + update refs from access-log.

Options:
  --all              Regenerate for all projects
  <project-name>     Regenerate for specific project(s)
  <directory-path>   Regenerate for a specific directory (e.g., experiments/)
  --help             Show this help`);
    process.exit(0);
  }

  if (args.includes('--all')) {
    regenAll();
  } else if (args.length > 0) {
    for (const arg of args) {
      // Check if it's a directory path or a project name
      if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
        const dirName = path.basename(arg);
        const parentName = path.basename(path.dirname(arg));
        generateIndex(arg, `${dirName.charAt(0).toUpperCase() + dirName.slice(1)} Index — ${parentName}`);
        log.info(`Generated ${arg}/index.md`);
      } else {
        regenProject(arg);
      }
    }
  } else {
    log.error('Usage: memory-index-regen.ts [--all | <project-name> ... | <directory-path>]');
    process.exit(1);
  }
}

export { generateIndex, parseFrontmatter, serializeFrontmatter, scanAtomicFiles };
