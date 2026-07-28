#!/usr/bin/env node
// @cortex-hook-version 2026.6.24  ← set to the current release version (agent-server/package.json) whenever you change this hook; syncManagedHooks then refreshes deployed installs
// input:  stdin JSON — Claude Code hook event or PI hook-bridge payload
// output: { hookSpecificOutput: { hookEventName, additionalContext, matched } }
// pos:    Inject CORTEX.md / CORTEX.local.md ancestor chain into agent context
//         2-event dispatch:
//           PostToolUse (Read|Edit) — from tool_input.file_path/path
//           SessionStart (startup|resume|clear|compact) — from payload.cwd
//         Shared per-session cache with remote MCP injection under tmp/cortexmd-cache
//           — stable session + physical host + path + mtime dedup across tool families
//           — only files actually injected are marked seen; truncated files stay eligible
//         markOnlyPaths: exact CORTEX.md tool target → cache update only, no duplicate
//         Total length guard at 9,500 chars; files that overflow the budget are turned into an
//           explicit "Read EACH of these files now" instruction instead of a silent drop
// >>> If I am updated, be sure to update my header comment and the CORTEX.md in the same folder <<<

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { homedir, hostname } from 'os';

const HOSTNAME = hostname();
const HOST_ID = HOSTNAME.toLowerCase();
const CORTEX_MD_NAMES = ['CORTEX.md', 'CORTEX.local.md'];
const CORTEX_HOME = process.env.CORTEX_HOME
  ? resolve(process.env.CORTEX_HOME)
  : join(homedir(), '.cortex');
const HOME_FALLBACK = join(CORTEX_HOME, 'CORTEX.md');
const MAX_FILE_SIZE = 200 * 1024;
const MAX_DEPTH = 20;
const CACHE_DIR = join(CORTEX_HOME, 'tmp', 'cortexmd-cache');
const MAX_CONTEXT_CHARS = 9500;
const LOCK_WAIT_MS = 250;
const LOCK_STALE_MS = 5000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

// ── scan helpers ──

function tryReadEntry(filePath) {
  try {
    const st = statSync(filePath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return null;
    if (st.size > MAX_FILE_SIZE) return null;
    const content = readFileSync(filePath, 'utf8');
    return { path: filePath, content, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Walk from the directory containing `targetFilePath` up to the filesystem root,
 *  collecting CORTEX.md and CORTEX.local.md at each level. Also appends the
 *  home fallback at ~/.cortex/CORTEX.md if present. Returns leaf→root order.
 *  If targetFilePath is a directory, scan that directory and its ancestors.
 *  If it is a file (or does not exist), scan its parent directory and ancestors. */
function scanChain(targetFilePath) {
  const entries = [];
  const seen = new Set();

  let resolved;
  try {
    resolved = resolve(targetFilePath);
  } catch {
    return entries;
  }

  let dir;
  try {
    const st = statSync(resolved, { throwIfNoEntry: false });
    dir = (st && st.isDirectory()) ? resolved : dirname(resolved);
  } catch {
    dir = dirname(resolved);
  }

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    for (const name of CORTEX_MD_NAMES) {
      const p = join(dir, name);
      if (seen.has(p)) continue;
      seen.add(p);
      const entry = tryReadEntry(p);
      if (entry) entries.push(entry);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Home fallback
  if (!seen.has(HOME_FALLBACK)) {
    seen.add(HOME_FALLBACK);
    const entry = tryReadEntry(HOME_FALLBACK);
    if (entry) entries.push(entry);
  }

  return entries;
}

// ── cache helpers ──

function loadCache(sessionId) {
  const cache = new Map();
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return cache;
  const cacheFile = join(CACHE_DIR, `${sessionId}.json`);
  try {
    if (!existsSync(cacheFile)) return cache;
    const raw = readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (typeof k === 'string' && typeof v === 'number') {
          cache.set(k, v);
        }
      }
    }
  } catch { /* corrupt/unreadable — start fresh */ }
  return cache;
}

function saveCache(sessionId, cache) {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const cacheFile = join(CACHE_DIR, `${sessionId}.json`);
    const obj = Object.fromEntries(cache);
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    renameSync(tmp, cacheFile);
  } catch { /* disk full etc. — degrade gracefully */ }
}

function lockFileFor(sessionId) {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  return join(CACHE_DIR, `${sessionId}.json.lock`);
}

function removeStaleLock(lockFile) {
  try {
    const st = statSync(lockFile);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) rmSync(lockFile, { force: true });
  } catch { /* ignore */ }
}

function acquireLock(sessionId) {
  const lockFile = lockFileFor(sessionId);
  if (!lockFile) return null;
  const deadline = Date.now() + LOCK_WAIT_MS;
  do {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      return { file: lockFile, descriptor: openSync(lockFile, 'wx') };
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      removeStaleLock(lockFile);
      Atomics.wait(LOCK_SLEEP, 0, 0, 5);
    }
  } while (Date.now() <= deadline);
  return null;
}

function releaseLock(lock) {
  if (!lock) return;
  try { closeSync(lock.descriptor); } catch { /* ignore */ }
  try { rmSync(lock.file, { force: true }); } catch { /* ignore */ }
}

function cacheKey(entry) {
  return `${HOST_ID}:${entry.path}`;
}

// ── context builder ──

function buildContext(entries) {
  if (entries.length === 0) return { text: '', includedPaths: [] };

  // Walk entries in original order (leaf→root), inlining each as a block until the char
  // budget is exhausted. Once exhausted, the remaining entries are NOT inlined — instead
  // they are turned into an explicit read-instruction below, so their rules are never
  // silently dropped (e.g. a root-level CORTEX.local.md carrying dev/safety rules).
  const includedBlocks = [];
  const includedPaths = [];
  const truncated = [];
  let totalLen = 0;
  let budgetExhausted = false;

  for (const e of entries) {
    const block = `<system-reminder>\nAuto-loaded CORTEX.md from ${HOSTNAME}:${e.path} (ancestor of accessed path). These instructions apply to files under this directory.\n\n${e.content}\n</system-reminder>`;
    if (budgetExhausted || totalLen + block.length > MAX_CONTEXT_CHARS) {
      budgetExhausted = true; // match prior behavior: stop inlining at the first overflow
      truncated.push(e);
      continue;
    }
    includedBlocks.push(block);
    includedPaths.push(e.path);
    totalLen += block.length;
  }

  const parts = [...includedBlocks];

  // Overflow → actionable instruction. Reading these files delivers their content via the
  // Read tool result; the markOnlyPaths branch then suppresses a duplicate inject.
  if (truncated.length > 0) {
    const list = truncated.map(e => `- ${e.path}`).join('\n');
    parts.push(
      `<system-reminder>\n⚠️ ${truncated.length} CORTEX rule file(s) were too large to inline here. ` +
      `Read EACH of the following files now to load their rules before proceeding:\n${list}\n</system-reminder>`
    );
  }

  if (parts.length === 0) return { text: '', includedPaths: [] };
  return { text: parts.join('\n\n'), includedPaths };
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

  const hookEventName = payload.hook_event_name;
  const stableSessionId = process.env.CORTEX_CACHE_SESSION_ID?.trim()
    || process.env.CORTEX_SESSION_ID?.trim();
  const sessionId = stableSessionId && SESSION_ID_RE.test(stableSessionId)
    ? stableSessionId
    : payload.session_id;

  let scanRoot = null;
  if (hookEventName === 'PostToolUse') {
    const toolName = payload.tool_name;
    if (toolName !== 'Read' && toolName !== 'Edit') return;
    scanRoot = payload.tool_input?.file_path || payload.tool_input?.path;
  } else if (hookEventName === 'SessionStart') {
    scanRoot = payload.cwd;
  }
  if (!scanRoot) return;

  const entries = scanChain(scanRoot);
  if (entries.length === 0) return;

  const lock = acquireLock(sessionId);
  try {
    const cache = loadCache(sessionId);
    const markOnlyPaths = new Set();
    if (hookEventName === 'PostToolUse') {
      const targetPath = resolve(payload.tool_input?.file_path || payload.tool_input?.path || '');
      if (CORTEX_MD_NAMES.includes(basename(targetPath))) markOnlyPaths.add(targetPath);
    }

    let changed = false;
    for (const entry of entries) {
      if (!markOnlyPaths.has(entry.path)) continue;
      if (cache.get(cacheKey(entry)) === entry.mtimeMs) continue;
      cache.set(cacheKey(entry), entry.mtimeMs);
      changed = true;
    }

    const newEntries = entries.filter(entry =>
      !markOnlyPaths.has(entry.path) && cache.get(cacheKey(entry)) !== entry.mtimeMs
    );
    if (newEntries.length === 0) {
      if (changed && lock) saveCache(sessionId, cache);
      return;
    }

    const { text: additionalContext, includedPaths } = buildContext(newEntries);
    if (!additionalContext) return;

    const injected = new Set(includedPaths);
    for (const entry of entries) {
      if (!injected.has(entry.path)) continue;
      cache.set(cacheKey(entry), entry.mtimeMs);
      changed = true;
    }
    if (changed && lock) saveCache(sessionId, cache);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext,
        matched: includedPaths,
      },
    }));
  } finally {
    releaseLock(lock);
  }
}

main();
