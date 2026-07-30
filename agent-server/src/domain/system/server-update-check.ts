// input:  update prompt/state, version, runtime settings
// output: compareCalVer, isUpdateDevMode, checkServerUpdate
// pos:    Checks and dispatches server package updates
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { getSettings } from '@core/settings.js';
import { CORTEX_VERSION } from '@core/version.js';
import type { UpdateChoice, UpdatePrompt } from './update-prompt.js';
import { loadUpdateState, saveUpdateState, type UpdateState } from './update-state.js';

// ── CalVer comparison ────────────────────────────────────────────
// Lives in @core/calver.js (platform/ui-http/app-update.ts needs it too and the platform layer may
// not depend on domain). Re-exported here so existing importers keep working.

import { compareCalVer } from '@core/calver.js';
export { compareCalVer };

// ── Dev mode detection ──────────────────────────────────────────
// In dev mode (CORTEX_REPO set), server auto-update is skipped entirely
// because the developer manages the install directly.

export function isUpdateDevMode(): boolean {
  const repo = process.env.CORTEX_REPO;
  if (!repo) return false;
  try {
    return fs.existsSync(repo) && fs.statSync(repo).isDirectory();
  } catch {
    return false;
  }
}

// ── Dependencies interface ──────────────────────────────────────

export interface CheckServerUpdateDeps {
  prompt: UpdatePrompt;
  getLatest?: () => string | null;
  spawnInstall?: () => void;
  loadState?: () => UpdateState | null;
  saveState?: (s: UpdateState) => void;
  now?: () => string;
}

// ── Default implementations ─────────────────────────────────────

function defaultGetLatest(): string | null {
  try {
    const result = execSync('npm view @cortex-agent/server version', {
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function defaultSpawnInstall(): void {
  const child = spawn('npm', ['install', '-g', '@cortex-agent/server@latest'], {
    detached: true,
    stdio: 'ignore',
    cwd: '/tmp',
  });
  child.unref();
}

function defaultNow(): string {
  return new Date().toISOString();
}

// ── Result type ─────────────────────────────────────────────────

export interface CheckServerUpdateResult {
  action: UpdateChoice | null;
  latestVersion: string | null;
}

// ── Main check-and-prompt flow ──────────────────────────────────

export async function checkServerUpdate(
  deps: CheckServerUpdateDeps,
): Promise<CheckServerUpdateResult> {
  // 1. Disable toggle: auto-update is on by default.
  if (getSettings().serverUpdateDisable) {
    return { action: null, latestVersion: null };
  }

  // 2. Dev mode: skip entirely
  if (isUpdateDevMode()) {
    return { action: null, latestVersion: null };
  }

  const getLatest = deps.getLatest ?? defaultGetLatest;
  const spawnInstall = deps.spawnInstall ?? defaultSpawnInstall;
  const loadState = deps.loadState ?? loadUpdateState;
  const saveState = deps.saveState ?? saveUpdateState;
  const now = deps.now ?? defaultNow;

  // 2. Fetch latest version
  const latestVersion = getLatest();
  if (latestVersion === null) {
    return { action: null, latestVersion: null };
  }

  // 3. Latest <= local: no update needed
  if (compareCalVer(latestVersion, CORTEX_VERSION) <= 0) {
    return { action: null, latestVersion };
  }

  // 4. Check if this version was skipped
  const state = loadState() ?? {};
  if (state.skippedVersion === latestVersion) {
    return { action: null, latestVersion };
  }

  // 5. Record check time and prompt
  const timestamp = now();
  saveState({
    ...state,
    lastCheckedAt: timestamp,
    lastPromptedVersion: latestVersion,
  });

  const choice = await deps.prompt.ask({ latestVersion });

  // 6. Dispatch user choice
  if (choice === 'apply') {
    saveState({
      ...state,
      skippedVersion: undefined,
      lastCheckedAt: timestamp,
      lastPromptedVersion: latestVersion,
    });
    spawnInstall();
    return { action: 'apply', latestVersion };
  }

  if (choice === 'skip') {
    saveState({
      ...state,
      skippedVersion: latestVersion,
      lastCheckedAt: timestamp,
      lastPromptedVersion: latestVersion,
    });
    return { action: 'skip', latestVersion };
  }

  // cancel / null: no state mutation beyond what was already saved
  return { action: choice, latestVersion };
}
