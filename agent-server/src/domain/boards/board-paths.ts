import * as path from 'node:path';
import { CONFIG_DIR, DEFAULTS_DIR } from '@core/paths.js';
import { projectStore } from '@domain/projects/project-store.js';

/** Board directories live under `<project contextDir>/boards/`. */
export const BOARDS_DIR = 'boards';
/** The agent-edited body fragment. */
export const BOARD_FILE = 'board.html';
/** Server-side projection of send_decision calls from bound sessions. */
export const DECISIONS_FILE = 'decisions.jsonl';

/** Shipped preset stylesheet and new-board scaffold. Versioned with the server, never copied
 *  into the Cortex home. */
export const DEFAULT_BOARD_CSS = path.join(DEFAULTS_DIR, 'board', 'board.css');
export const BOARD_SCAFFOLD = path.join(DEFAULTS_DIR, 'board', 'scaffold.html');
/** Optional user override, loaded after the default preset. Absent by default. */
export const USER_BOARD_CSS = path.join(CONFIG_DIR, 'board.css');

/** A board's directory (or a file in it) relative to the project context dir. */
export function boardRelPath(slug: string, file?: string): string {
  return file ? path.join(BOARDS_DIR, slug, file) : path.join(BOARDS_DIR, slug);
}

function contextDirOf(projectId: string): string | null {
  return projectStore.get(projectId)?.contextDir ?? null;
}

export function boardDir(projectId: string, slug: string): string | null {
  const contextDir = contextDirOf(projectId);
  return contextDir ? path.join(contextDir, boardRelPath(slug)) : null;
}

export function boardDecisionsFile(projectId: string, slug: string): string | null {
  const contextDir = contextDirOf(projectId);
  return contextDir ? path.join(contextDir, boardRelPath(slug, DECISIONS_FILE)) : null;
}
