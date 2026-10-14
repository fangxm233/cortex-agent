#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import {
  isValidSessionId, loadLayeredRules, pruneCacheDir, readJsonFile, rulesCacheDir, writeJsonFileAtomic,
} from './cortex-context-lib.mjs';

const DATA_DIR = process.env.CORTEX_HOME
  ? resolve(process.env.CORTEX_HOME)
  : join(homedir(), '.cortex');
const RULES_DIR = join(DATA_DIR, 'rules');
const CACHE_DIR = rulesCacheDir(DATA_DIR);

// ── cache helpers ──

function cacheFile(sessionId) {
  return isValidSessionId(sessionId) ? join(CACHE_DIR, `${sessionId}.json`) : null;
}

/** Rule file names already injected in this session. */
function loadCache(sessionId) {
  const file = cacheFile(sessionId);
  const data = file ? readJsonFile(file) : null;
  return new Set(Array.isArray(data) ? data.filter((f) => typeof f === 'string') : []);
}

function saveCache(sessionId, cache) {
  const file = cacheFile(sessionId);
  if (file) writeJsonFileAtomic(file, Array.from(cache));
}

/** Rules scoped by a non-empty `paths` frontmatter list, built-in and the user's; global rules
 *  reach the prompt elsewhere. */
function loadScopedRules() {
  return loadLayeredRules(RULES_DIR).filter((rule) => rule.paths.length > 0);
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
        matched.push({ file: rule.file, path: rule.path, body: rule.body });
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
  pruneCacheDir(CACHE_DIR);
  const cache = loadCache(sessionId);
  const newMatched = matched.filter(r => !cache.has(r.file));

  // Update cache with all matched rules (even already-seen ones, to refresh mtime)
  for (const r of matched) cache.add(r.file);
  saveCache(sessionId, cache);

  if (newMatched.length === 0) return;

  // Build system-reminder blocks for Claude's additionalContext
  const blocks = newMatched.map(r =>
    `<system-reminder>\nApplied rule from ${r.path}:\n\n${r.body}\n</system-reminder>`
  );
  const context = blocks.join('\n\n');

  // Both backends read hookSpecificOutput.additionalContext.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context,
    },
  }));
}

main();
