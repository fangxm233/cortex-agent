import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '@core/utils.js';

const RULES_DIR = path.join(DATA_DIR, 'rules');
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const PATH_LINE_RE = /^\s*-\s+["']?(.+?)["']?\s*$/;

export interface RuleEntry {
  /** Absolute path to the rule file. */
  path: string;
  /** File name without extension (e.g. "experiment-format"). */
  name: string;
  /** Full file content including frontmatter. */
  content: string;
  /** Body text after frontmatter. */
  body: string;
  /** Glob patterns from frontmatter `paths:` field. Empty array = global rule. */
  paths: string[];
  /** File mtime in ms epoch. */
  mtimeMs: number;
}

function parseFrontmatter(content: string): { paths: string[]; body: string } {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { paths: [], body: content };
  const fmBlock = m[1];
  const body = content.slice(m[0].length);
  const paths: string[] = [];
  for (const line of fmBlock.split('\n')) {
    const pm = line.match(PATH_LINE_RE);
    if (pm) paths.push(pm[1]);
  }
  return { paths, body };
}

/**
 * Read all markdown files from ~/.cortex/rules/ and return them
 * partitioned into global (no `paths` frontmatter) and scoped (has `paths`).
 */
export function loadCortexRules(): { global: RuleEntry[]; scoped: RuleEntry[] } {
  const global: RuleEntry[] = [];
  const scoped: RuleEntry[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(RULES_DIR);
  } catch {
    return { global, scoped };
  }

  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(RULES_DIR, f);
    try {
      const stat = fs.statSync(fp, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) continue;
      const content = fs.readFileSync(fp, 'utf8');
      const { paths: frontPaths, body } = parseFrontmatter(content);
      const entry: RuleEntry = {
        path: fp,
        name: f.replace(/\.md$/, ''),
        content,
        body,
        paths: frontPaths,
        mtimeMs: stat.mtimeMs,
      };
      if (frontPaths.length > 0) {
        scoped.push(entry);
      } else {
        global.push(entry);
      }
    } catch {
      // skip unreadable files
    }
  }

  return { global, scoped };
}

/**
 * Convert a glob pattern to a regex. Supports ** (multi-segment) and * (single segment).
 * Simple implementation — no external dependency.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00GLOBSTAR\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00GLOBSTAR\x00/g, '.*');
  return new RegExp(escaped);
}

/**
 * Given a file path and a list of scoped rules, return the rules whose
 * `paths` patterns match the file path.
 */
export function resolveScopedRules(filePath: string, scoped: RuleEntry[]): RuleEntry[] {
  const matched: RuleEntry[] = [];
  for (const rule of scoped) {
    for (const pattern of rule.paths) {
      if (globToRegex(pattern).test(filePath)) {
        matched.push(rule);
        break;
      }
    }
  }
  return matched;
}
