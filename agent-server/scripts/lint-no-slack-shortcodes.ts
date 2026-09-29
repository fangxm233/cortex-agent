#!/usr/bin/env node
// Lint: check for remaining Slack emoji shortcodes (:shortcode:) in source files.
// Exits non-zero if any are found in string literals. Meant to run as part of npm test.
//
// Scope: agent-server/src/{core,domain,orchestration,events}/**/*.ts
// Excludes: comments, markdown links
//
// Uses a known-emoji allowlist (derived from core/icons.ts) to avoid false-positives
// on patterns like actionId: "cmd:status:refresh" which contain :status: and :refresh:.

import * as fs from 'fs';
import * as path from 'path';

// Allowlist of known Slack emoji shortcodes (matches Icons keys' original shortcodes)
const KNOWN_SHORTCODES = new Set([
  'warning', 'white_check_mark', 'x',
  'arrows_counterclockwise', 'hourglass_flowing_sand', 'stopwatch',
  'repeat', 'satellite', 'leftwards_arrow_with_hook', 'hook',
  'speech_balloon', 'fast_forward', 'octagonal_sign', 'memo',
  'brain', 'file_folder', 'desktop_computer', 'scroll',
  'wave', 'no_entry', 'no_entry_sign', 'heavy_plus_sign',
  'inbox_tray', 'pencil2', 'wrench', 'arrow_right', 'arrow_left',
  'arrow_forward', 'double_vertical_bar', 'clock1', 'radio_button',
  'hourglass', 'robot_face', 'robot',
]);

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(AGENT_DIR, 'src');

function findTsFiles(): string[] {
  const dirs = ['core', 'domain', 'orchestration', 'events'];
  const results: string[] = [];
  for (const dir of dirs) {
    const fullDir = path.join(SRC_DIR, dir);
    if (!fs.existsSync(fullDir)) continue;
    walkDir(fullDir, results);
  }
  return results;
}

function walkDir(dir: string, acc: string[]): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, acc);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        acc.push(fullPath);
      }
    }
  } catch {}
}

// Regex to find :shortcode: patterns in string-like contexts
const SHORTCODE_RE = /:([a-z][a-z0-9_]+):/g;

interface Hit {
  file: string;
  line: number;
  shortcode: string;
}

function lintFile(filePath: string): Hit[] {
  const relative = path.relative(AGENT_DIR, filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comment-only lines
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Find all shortcode matches in this line
    let match: RegExpExecArray | null;
    while ((match = SHORTCODE_RE.exec(line)) !== null) {
      const shortcode = match[1];

      // Skip if not a known emoji shortcode (avoids false-positives on action IDs, etc.)
      if (!KNOWN_SHORTCODES.has(shortcode)) continue;

      // Check if it's inside a string literal (between quotes/backticks)
      // Simple heuristic: check if there's an unclosed quote before/around the match
      if (!isInsideStringLiteral(line, match.index)) continue;

      // Check if inside a comment
      if (isInsideComment(line, match.index)) continue;

      // Check if inside a markdown link [text](url)
      if (isInsideMarkdownLink(line, match.index)) continue;

      hits.push({
        file: relative,
        line: i + 1,
        shortcode: `:${shortcode}:`,
      });
    }
  }

  return hits;
}

function isInsideStringLiteral(line: string, index: number): boolean {
  // Count quote characters before the match to determine if we're inside a string
  const before = line.slice(0, index);
  const singleQuotes = (before.match(/'/g) || []).length;
  const doubleQuotes = (before.match(/"/g) || []).length;
  const backticks = (before.match(/`/g) || []).length;

  // Inside a string if an odd number of any quote type
  return singleQuotes % 2 === 1 || doubleQuotes % 2 === 1 || backticks % 2 === 1;
}

function isInsideComment(line: string, index: number): boolean {
  const before = line.slice(0, index);
  // Line comment
  if (before.includes('//')) return true;
  // Block comment
  const lastBlockOpen = before.lastIndexOf('/*');
  const lastBlockClose = before.lastIndexOf('*/');
  if (lastBlockOpen > lastBlockClose) return true;
  return false;
}

function isInsideMarkdownLink(line: string, index: number): boolean {
  // Check if match is inside [text](url) — look for `](` pattern before the match
  const before = line.slice(0, index);
  // Simple check: if there's a `](` and no `)` after the match position
  // More robust: check for markdown link pattern
  const linkMatch = before.match(/\[([^\]]*)\]\(([^)]*)$/);
  if (linkMatch) {
    const linkTextEnd = before.lastIndexOf('](');
    if (linkTextEnd >= 0 && index > linkTextEnd) return true;
  }
  return false;
}

function main(): void {
  const files = findTsFiles();
  let allHits: Hit[] = [];
  let errorCount = 0;

  for (const file of files) {
    try {
      const hits = lintFile(file);
      if (hits.length > 0) {
        for (const hit of hits) {
          console.error(`  ${hit.file}:${hit.line}  ${hit.shortcode}`);
        }
        allHits = allHits.concat(hits);
      }
    } catch (err) {
      console.error(`  ERROR reading ${path.relative(AGENT_DIR, file)}: ${err}`);
      errorCount++;
    }
  }

  if (allHits.length > 0) {
    console.error(`\n❌ Found ${allHits.length} Slack emoji shortcode(s) in string literals. Use Icons.X from core/icons.ts instead.`);
    process.exit(1);
  }

  if (errorCount > 0) {
    console.error(`\n⚠️  ${errorCount} file(s) could not be read.`);
    process.exit(1);
  }

  console.log('✅ No Slack emoji shortcodes found in source files.');
}

main();
