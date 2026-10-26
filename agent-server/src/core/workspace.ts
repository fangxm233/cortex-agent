// Clean-mode workspaces: the folder a clean session or subagent runs in, the `inputs/` it is
// handed, and the system-prompt section that keeps the agent inside it.

import { existsSync, mkdirSync, readFileSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLEAN_WORKSPACES_DIR, DEFAULTS_DIR, PROMPTS_DIR } from './paths.js';
import { resolveAvailablePath, sanitizeDisplayFilename } from './workspace-filenames.js';

/** Where a workspace's given files live, relative to the workspace. */
export const WORKSPACE_INPUTS_DIR = 'inputs';

/** The workspace prompt file; a file of the same name under PROMPTS_DIR replaces the shipped one. */
export const WORKSPACE_PROMPT_FILE = 'clean-workspace.md';

/** A clean session's workspace, or null for a session that is not clean. */
export function cleanWorkspaceOf(session?: { clean?: boolean; workspaceDir?: string | null } | null): string | null {
  return session?.clean === true && session.workspaceDir ? session.workspaceDir : null;
}

/** Create `<root>/<name>/inputs/` and return the workspace's absolute path. A name already taken
 *  gets a numeric suffix (`name-2`, `name-3`, …) rather than sharing another run's folder. */
export function createWorkspace(name: string, root: string = CLEAN_WORKSPACES_DIR): string {
  mkdirSync(root, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const dir = path.join(root, attempt === 1 ? name : `${name}-${attempt}`);
    if (!tryMkdir(dir)) continue;
    mkdirSync(path.join(dir, WORKSPACE_INPUTS_DIR));
    return dir;
  }
}

function tryMkdir(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Copy a file or directory into the workspace's `inputs/` under its own name and return the copy's
 * absolute path. A different file already holding the name gets a suffixed name; an identical file
 * is reused, so a turn prepared twice (an edit retry) does not leave duplicates behind.
 */
export async function copyIntoInputs(workspace: string, source: string, name?: string): Promise<string> {
  const inputs = path.join(workspace, WORKSPACE_INPUTS_DIR);
  await fsp.mkdir(inputs, { recursive: true });
  const base = sanitizeDisplayFilename(name || path.basename(source));
  const existing = path.join(inputs, base);
  if (await sameFile(source, existing)) return existing;
  const { destPath } = await resolveAvailablePath(inputs, base);
  await fsp.cp(source, destPath, { recursive: true });
  return destPath;
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([fsp.stat(a).catch(() => null), fsp.stat(b).catch(() => null)]);
  if (!left?.isFile() || !right?.isFile() || left.size !== right.size) return false;
  const [leftBytes, rightBytes] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
  return leftBytes.equals(rightBytes);
}

/** A path as a caller wrote it — absolute, `~`-relative, or relative to `cwd` — made absolute. */
export function resolveGivenPath(given: string, cwd: string): string {
  const expanded = given === '~' || given.startsWith('~/') ? path.join(os.homedir(), given.slice(1)) : given;
  return path.resolve(cwd, expanded);
}

/** The workspace section appended to a clean run's system prompt, `{{workspace}}` filled in. */
export function workspacePrompt(workspace: string): string {
  const userFile = path.join(PROMPTS_DIR, WORKSPACE_PROMPT_FILE);
  const file = existsSync(userFile) ? userFile : path.join(DEFAULTS_DIR, 'prompts', WORKSPACE_PROMPT_FILE);
  return readFileSync(file, 'utf8').replaceAll('{{workspace}}', workspace).trim();
}
