#!/usr/bin/env node
// @cortex-hook-version 2026.6.22-2
// input:  stdin JSON — Claude Code PostToolUse event or PI hook-bridge payload
// output: { matched: [...], hookSpecificOutput: { additionalContext: "..." } }
// pos:    Read/Grep hook — check if file path matches scoped rules in ~/.cortex/rules/
//         On match, return rule content for Claude (additionalContext) and PI (content mutation) injection
//         Session-level dedup: each rule injected at most once per session (on first match)
// >>> If I am updated, be sure to update my header comment and the AGENTS.md in the same folder <<<

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';

const DATA_DIR = process.env.CORTEX_HOME
  ? resolve(process.env.CORTEX_HOME)
  : join(homedir(), '.cortex');
const RULES_DIR = join(DATA_DIR, 'rules');
const CACHE_DIR = join(DATA_DIR, 'tmp', 'rules-cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const PATH_LINE_RE = /^\s*-\s+["']?(.+?)["']?\s*$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

// ── cache helpers ──

/**
 * Load the dedup cache for a session. Returns a Set of already-injected rule file names.
 */
function loadCache(sessionId) {
  const cache = new Set();
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return cache;
  const cacheFile = join(CACHE_DIR, `${sessionId}.json`);
  try {
    if (!existsSync(cacheFile)) return cache;
    const raw = readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const f of data) {
        if (typeof f === 'string') cache.add(f);
      }
    }
  } catch { /* corrupt/unreadable — start fresh */ }
  return cache;
}

/**
 * Persist the dedup cache for a session. Atomic write via tmp file + rename.
 */
function saveCache(sessionId, cache) {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const cacheFile = join(CACHE_DIR, `${sessionId}.json`);
    const arr = Array.from(cache);
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(arr), 'utf8');
    renameSync(tmp, cacheFile);
  } catch { /* disk full etc. — degrade gracefully */ }
}

/**
 * Remove stale session cache files (> CACHE_TTL_MS old). Best-effort.
 */
function maintainCacheDir() {
  try {
    if (!existsSync(CACHE_DIR)) return;
    const now = Date.now();
    for (const name of readdirSync(CACHE_DIR)) {
      const p = join(CACHE_DIR, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > CACHE_TTL_MS) {
          try { require('fs').rmSync(p, { force: true }); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ── rule parsing ──

/**
 * Parse YAML frontmatter from rule content.
 * Returns { paths, body } where paths is the `paths:` array and body is text after frontmatter.
 */
function parseFrontmatter(content) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { paths: [], body: content };
  const fmBlock = m[1];
  const body = content.slice(m[0].length);
  const paths = [];
  for (const line of fmBlock.split('\n')) {
    const pm = line.match(PATH_LINE_RE);
    if (pm) paths.push(pm[1]);
  }
  return { paths, body };
}

/**
 * Load all scoped rules (those with non-empty `paths` frontmatter).
 */
function loadScopedRules() {
  const rules = [];
  let files;
  try { files = readdirSync(RULES_DIR); } catch { return rules; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const fp = join(RULES_DIR, f);
    try {
      const st = statSync(fp);
      if (!st.isFile()) continue;
      const content = readFileSync(fp, 'utf8');
      const { paths, body } = parseFrontmatter(content);
      if (paths.length === 0) continue;
      rules.push({ file: f, paths, body, mtimeMs: st.mtimeMs });
    } catch { /* skip unreadable */ }
  }
  return rules;
}

/**
 * Simple glob-to-regex. Supports ** (multi-segment) and * (single segment).
 */
function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00GLOBSTAR\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00GLOBSTAR\x00/g, '.*');
  return new RegExp(escaped);
}

/**
 * Match a file path against scoped rules' glob patterns.
 * Returns array of { file, body } for matched rules.
 */
function matchRules(filePath, scopedRules) {
  const matched = [];
  for (const rule of scopedRules) {
    for (const pattern of rule.paths) {
      if (globToRegex(pattern).test(filePath)) {
        matched.push({ file: rule.file, body: rule.body });
        break;
      }
    }
  }
  return matched;
}

// ── main ──

function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    return;
  }

  if (!input.trim()) return;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  const toolName = payload.tool_name;
  if (toolName !== 'Read' && toolName !== 'Grep') return;

  const filePath = payload.tool_input?.file_path || payload.tool_input?.path;
  if (!filePath) return;

  const scopedRules = loadScopedRules();
  if (scopedRules.length === 0) return;

  const matched = matchRules(filePath, scopedRules);
  if (matched.length === 0) return;

  // ── session dedup ──
  const sessionId = payload.session_id;
  maintainCacheDir();
  const cache = loadCache(sessionId);
  const newMatched = matched.filter(r => !cache.has(r.file));

  // Update cache with all matched rules (even already-seen ones, to refresh mtime)
  for (const r of matched) cache.add(r.file);
  saveCache(sessionId, cache);

  if (newMatched.length === 0) return;

  // Build system-reminder blocks for Claude's additionalContext
  const blocks = newMatched.map(r =>
    `<system-reminder>\nApplied rule from ~/.cortex/rules/${r.file}:\n\n${r.body}\n</system-reminder>`
  );
  const context = blocks.join('\n\n');

  // Output served to both backends:
  //   .matched              → PI hook-bridge reads this for content mutation
  //   .hookSpecificOutput   → Claude Code reads this for additionalContext
  process.stdout.write(JSON.stringify({
    matched: newMatched,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context,
    },
  }));
}

main();
