import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '@core/paths.js';

const RULES_DIR = path.join(DATA_DIR, 'rules');
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const PATH_LINE_RE = /^\s*-\s+["']?(.+?)["']?\s*$/;

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
 * Read all markdown files from ~/.cortex/rules/ and return the bodies of the global rules
 * (no `paths` frontmatter). Path-scoped rules are skipped; the rules-loader hook applies them.
 */
export function loadCortexRules(): string[] {
  const bodies: string[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(RULES_DIR);
  } catch {
    return bodies;
  }

  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(RULES_DIR, f);
    try {
      const stat = fs.statSync(fp, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) continue;
      const content = fs.readFileSync(fp, 'utf8');
      const { paths: frontPaths, body } = parseFrontmatter(content);
      if (frontPaths.length === 0) bodies.push(body);
    } catch {
      // skip unreadable files
    }
  }

  return bodies;
}
