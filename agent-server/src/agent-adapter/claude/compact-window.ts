import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_CONFIG_HOME } from '@core/paths.js';
import { getSettings } from '@core/settings.js';

/** The CLI schema accepts an integer in this range and drops anything else. */
const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;

function readWindow(file: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    const value = parsed?.autoCompactWindow;
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    return value >= MIN_WINDOW && value <= MAX_WINDOW ? value : null;
  } catch {
    return null;
  }
}

/**
 * Claude caps its usable context at `min(model window, autoCompactWindow)`, but reports only the
 * full model window in `result.modelUsage`, so the configured value has to be read from the same
 * settings files the CLI reads, highest precedence first. Out-of-range entries fall through to the
 * next file exactly as the CLI schema drops them. An ambient `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is
 * not consulted: buildClaudeEnv strips every inherited `CLAUDE_CODE*` variable and sets that one
 * only from Cortex's own cap, which {@link resolveClaudeCompactWindow} applies on top.
 * The user settings file is Cortex's own Claude config dir unless the caller names another.
 */
export function resolveAutoCompactWindow(
  cwd: string,
  userConfigDir: string = CLAUDE_CONFIG_HOME,
): number | null {
  const files = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(userConfigDir, 'settings.json'),
  ];
  for (const file of files) {
    const window = readWindow(file);
    if (window !== null) return window;
  }
  return null;
}

/**
 * The window the spawned CLI compacts against. Cortex's `maxContextTokens` reaches the CLI as
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which outranks every settings file; a pinned trial gets no cap.
 */
export function resolveClaudeCompactWindow(
  cwd: string,
  opts: { pinned: boolean; userConfigDir?: string },
): number | null {
  const cap = opts.pinned ? null : getSettings().maxContextTokens;
  return cap ?? resolveAutoCompactWindow(cwd, opts.userConfigDir);
}
