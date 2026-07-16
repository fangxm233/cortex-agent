// input:  nothing (leaf module)
// output: INSTALL_ROOT / DEFAULTS_DIR / DATA_DIR / CONFIG_DIR / STORE_DIR / CONTEXT_DIR / PROJECTS_DIR / WORKSPACE_DIR / resolveWorkspaceRelPath / PLUGINS_DIR / PROMPTS_DIR / HOOKS_DIR
//         (deprecated re-exports: PACKAGE_ROOT, SERVER_ROOT, REPO_ROOT) + moduleDir + utility helpers
// pos:    cross-module shared constants and ESM/time/path utilities
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  INSTALL_ROOT,
  DEFAULTS_DIR,
  PACKAGE_ROOT,
  SERVER_ROOT,
  REPO_ROOT,
  DATA_DIR,
  CONFIG_DIR,
  STORE_DIR,
  CONTEXT_DIR,
  PROJECTS_DIR,
  WORKSPACE_DIR,
  resolveWorkspaceRelPath,
  PLUGINS_DIR,
  PROMPTS_DIR,
  HOOKS_DIR,
} from './paths.js';

/** Directories to skip during recursive filesystem scans */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tmp', 'logs', '__pycache__']);

function moduleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  const thisFile = fileURLToPath(importMetaUrl);
  const invoked = path.resolve(process.argv[1]);
  if (invoked === thisFile) return true;
  try { return fs.realpathSync(invoked) === thisFile; } catch { return false; }
}

function readableTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

/** Split text into chunks of maxChunk chars, breaking at line boundaries.
 *  When hrSplitEvery > 0, also force a new chunk before the Nth horizontal
 *  rule (---) to avoid Slack's "Show full message" truncation. */
function chunkText(text, maxChunk = 3000, hrSplitEvery = 3) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  let hrCount = 0;
  for (const line of lines) {
    const isHr = hrSplitEvery > 0 && /^-{3,}\s*$/.test(line.trim());
    const wouldExceedChars = current.length + line.length + 1 > maxChunk && current.length > 0;
    const wouldExceedHrs = isHr && hrCount + 1 >= hrSplitEvery && current.length > 0;

    if (wouldExceedChars || wouldExceedHrs) {
      chunks.push(current);
      current = line;
      hrCount = isHr ? 1 : 0;
    } else {
      current = current ? current + '\n' + line : line;
      if (isHr) hrCount++;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Format seconds as compact human-readable duration (e.g. "5s", "2m 30s", "1m") */
function formatDurationCompact(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Today's date as ISO string (YYYY-MM-DD) */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * List subdirectories of PROJECTS_DIR that look like project folders.
 *
 * Filters out:
 *   - non-directories (e.g. top-level files like CORTEX.md, AGENTS.md that
 *     some users keep next to their projects/ tree)
 *   - dotfiles (.git, .obsidian, etc.)
 *
 * Returns [] if the directory does not exist or is unreadable.
 * Use this everywhere instead of `fs.readdirSync(PROJECTS_DIR)` to avoid
 * treating stray files as projects (would surface as ghost projects in
 * `cortex-task lock-status`, `stats`, id-assignment, etc.).
 */
function listProjectDirs(projectsDir: string = PROJECTS_DIR): string[] {
  if (!fs.existsSync(projectsDir)) return [];
  try {
    return fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Sentinel ANTHROPIC_API_KEY value set when the gateway is healthy but no real key exists.
 * Its only purpose is to satisfy Claude Code's startup credential check on machines without
 * OAuth login — upstream auth is handled by the gateway's own configured keys. Anything that
 * treats ANTHROPIC_API_KEY as a real credential (gateway-generator discovery, saved-env
 * snapshots) must ignore this value.
 */
const GATEWAY_MANAGED_KEY_PLACEHOLDER = 'cortex-gateway-managed';

export { INSTALL_ROOT, DEFAULTS_DIR, PACKAGE_ROOT, SERVER_ROOT, REPO_ROOT, DATA_DIR, CONFIG_DIR, STORE_DIR, CONTEXT_DIR, PROJECTS_DIR, WORKSPACE_DIR, resolveWorkspaceRelPath, PLUGINS_DIR, PROMPTS_DIR, HOOKS_DIR, SKIP_DIRS, GATEWAY_MANAGED_KEY_PLACEHOLDER, moduleDir, isMainModule, readableTimestamp, chunkText, formatDurationCompact, todayISO, listProjectDirs };
