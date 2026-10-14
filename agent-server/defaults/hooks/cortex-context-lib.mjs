// Not a hook entry. Shared by the agents-md-injector and rules-loader hooks (imported as
// ./cortex-context-lib.mjs next to them) and by the server's MCP-side AGENTS.md injector and rules
// loader (imported from the shipped defaults/hooks/). One copy keeps the dedup cache format, its
// keys and the rules frontmatter grammar identical on both sides.

import {
  closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Inline budget for injected AGENTS.md blocks; the rest become a read instruction. */
export const MAX_CONTEXT_CHARS = 9500;

const LOCK_WAIT_MS = 250;
const LOCK_STALE_MS = 5000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

// ── cache files ──

/** Per-session AGENTS.md dedup cache, shared by the hook and the MCP-side injector. The directory
 *  name predates the AGENTS.md rename; renaming it would orphan every live session's dedup state. */
export function agentsMdCacheDir(home) {
  return join(home, 'tmp', 'cortexmd-cache');
}

export function rulesCacheDir(home) {
  return join(home, 'tmp', 'rules-cache');
}

export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

/** Cache key of one AGENTS.md: the physical host it lives on (lowercased) and its absolute path. */
export function agentsMdCacheKey(deviceId, filePath) {
  return `${String(deviceId).trim().toLowerCase()}:${filePath}`;
}

/** Remove cache files older than `ttlMs`. Best-effort. */
export function pruneCacheDir(dir, ttlMs = CACHE_TTL_MS) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const filePath = join(dir, name);
    try {
      const st = statSync(filePath);
      if (st.isFile() && now - st.mtimeMs > ttlMs) rmSync(filePath, { force: true });
    } catch { /* ignore */ }
  }
}

/** Parsed JSON of `file`, or null when missing or corrupt. */
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write JSON through a sibling temp file + rename. Best-effort: a full disk degrades to no cache. */
export function writeJsonFileAtomic(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameSync(tmp, file);
  } catch { /* degrade gracefully */ }
}

function readMtimeCache(file) {
  const cache = new Map();
  const data = readJsonFile(file);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return cache;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'number') cache.set(key, value);
  }
  return cache;
}

function removeStaleLock(lockFile) {
  try {
    if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) rmSync(lockFile, { force: true });
  } catch { /* ignore */ }
}

function acquireLock(lockFile) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  do {
    try {
      mkdirSync(dirname(lockFile), { recursive: true });
      return openSync(lockFile, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      removeStaleLock(lockFile);
      Atomics.wait(LOCK_SLEEP, 0, 0, 5);
    }
  } while (Date.now() <= deadline);
  return null;
}

function releaseLock(lockFile, descriptor) {
  try { closeSync(descriptor); } catch { /* ignore */ }
  try { rmSync(lockFile, { force: true }); } catch { /* ignore */ }
}

/**
 * Run `operation` on a session's AGENTS.md cache (key → mtimeMs) under its file lock, re-reading
 * the file first so concurrent writers are observed. `operation` returns `{ value, changed }`; the
 * cache is persisted only when it changed and the lock was taken. An invalid session id has no
 * file: `operation` runs on `memoryCache` (a fresh map when omitted).
 */
export function withAgentsMdCache(cacheDir, sessionId, operation, memoryCache = new Map()) {
  if (!isValidSessionId(sessionId)) return operation(memoryCache).value;
  const cacheFile = join(cacheDir, `${sessionId}.json`);
  const lockFile = `${cacheFile}.lock`;
  const descriptor = acquireLock(lockFile);
  try {
    const cache = readMtimeCache(cacheFile);
    const result = operation(cache);
    if (descriptor !== null && result.changed) writeJsonFileAtomic(cacheFile, Object.fromEntries(cache));
    return result.value;
  } finally {
    if (descriptor !== null) releaseLock(lockFile, descriptor);
  }
}

// ── injection budget ──

/**
 * Split `entries` (leaf → root order) into the ones inlined as blocks and the ones past the
 * budget. Inlining stops at the first block that does not fit, so a later small file never jumps
 * ahead of an earlier large one.
 */
export function selectWithinBudget(entries, formatBlock, maxChars = MAX_CONTEXT_CHARS) {
  const included = [];
  const blocks = [];
  const truncated = [];
  let total = 0;
  for (const entry of entries) {
    const block = formatBlock(entry);
    if (truncated.length > 0 || total + block.length > maxChars) {
      truncated.push(entry);
      continue;
    }
    included.push(entry);
    blocks.push(block);
    total += block.length;
  }
  return { included, blocks, truncated };
}

/** Read instruction for the files that did not fit, so their rules are never silently dropped. */
export function overflowNotice(labels) {
  return `<system-reminder>\n⚠️ ${labels.length} AGENTS rule file(s) were too large to inline here. ` +
    `Read EACH of the following files now to load their rules before proceeding:\n` +
    `${labels.map((label) => `- ${label}`).join('\n')}\n</system-reminder>`;
}

// ── rules ──

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PATHS_KEY_RE = /^paths:[ \t]*(.*)$/;
const LIST_ITEM_RE = /^\s+-\s+(.*?)\s*$/;
const FLOW_ITEM_RE = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^,\s][^,]*)/g;

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function flowItems(inner) {
  const items = [];
  for (const match of inner.matchAll(FLOW_ITEM_RE)) {
    const value = match[1] ?? match[2] ?? match[3].trim();
    if (value) items.push(value);
  }
  return items;
}

/**
 * The `paths:` globs and the body of a rule file. Only the `paths` key is read: a block list
 * (`paths:` then `  - "glob"` lines), a flow list (`paths: ["a", "b"]`) or a single glob. Any
 * other list in the frontmatter is not a path.
 */
export function parseRuleFrontmatter(content) {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { paths: [], body: content };
  const body = content.slice(match[0].length);
  const lines = match[1].split(/\r?\n/);
  const paths = [];
  for (let i = 0; i < lines.length; i++) {
    const key = PATHS_KEY_RE.exec(lines[i]);
    if (!key) continue;
    const inline = key[1].replace(/\s+#.*$/, '').trim();
    if (inline.startsWith('[') && inline.endsWith(']')) {
      paths.push(...flowItems(inline.slice(1, -1)));
    } else if (inline) {
      paths.push(unquote(inline));
    } else {
      for (i += 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || /^\s+#/.test(line)) continue;
        const item = LIST_ITEM_RE.exec(line);
        if (!item) break;
        const value = unquote(item[1]);
        if (value) paths.push(value);
      }
    }
    break;
  }
  return { paths, body };
}

function ruleFileNames(rulesDir) {
  try {
    return readdirSync(rulesDir).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }
}

function readRule(file, filePath) {
  try {
    if (!statSync(filePath).isFile()) return null;
    const { paths, body } = parseRuleFrontmatter(readFileSync(filePath, 'utf8'));
    return { file, path: filePath, paths, body };
  } catch {
    return null;
  }
}

/** Every `*.md` rule in `rulesDir`, in file-name order, with its parsed `paths` and body. */
export function loadRules(rulesDir) {
  return ruleFileNames(rulesDir).sort()
    .map((file) => readRule(file, join(rulesDir, file)))
    .filter((rule) => rule !== null);
}

/** The rules Cortex ships, read in place from the install. */
export const BUILTIN_RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

/** The shipped rules directory, or null in a sealed home (CORTEX_CONFIG_IMMUTABLE=1), which loads
 *  only the rules it carries itself. */
export function builtinRulesDir() {
  return process.env.CORTEX_CONFIG_IMMUTABLE === '1' ? null : BUILTIN_RULES_DIR;
}

/** The built-in rules overlaid with the user's: a user rule replaces the built-in of the same file
 *  name, a new name adds. File-name order, like {@link loadRules}. */
export function loadLayeredRules(userDir, builtinDir = builtinRulesDir()) {
  const byFile = new Map();
  if (builtinDir) for (const file of ruleFileNames(builtinDir)) byFile.set(file, join(builtinDir, file));
  for (const file of ruleFileNames(userDir)) byFile.set(file, join(userDir, file));
  return [...byFile.keys()].sort()
    .map((file) => readRule(file, byFile.get(file)))
    .filter((rule) => rule !== null);
}
