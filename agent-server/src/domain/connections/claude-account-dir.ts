// Each additional Claude account runs Claude Code on a config dir of its own, so its login never
// mixes with another account's. Only the login is the account's: every other top-level entry —
// transcripts, plugins, skills, settings — links back to Cortex's own config dir, so all accounts
// write one transcript store and a session resumes on any of them.

import fs from 'node:fs';
import path from 'node:path';
import { CONNECTION_ID_RE } from '@core/connections-file.js';
import { createLogger } from '@core/log.js';
import { CLAUDE_ACCOUNTS_HOME, CLAUDE_CONFIG_HOME } from '@core/paths.js';

const log = createLogger('claude-account-dir');

/** The account's own: its credential, its account record (`oauthAccount`, model access) and backups. */
const ACCOUNT_OWN = new Set(['.credentials.json', '.claude.json', 'backups']);
/** Created in the shared dir before linking, so the CLI never makes an account-local one instead. */
const SHARED_DIRS = ['projects'];
const SETTINGS_FILE = 'settings.json';

export interface ClaudeAccountDirDeps {
  /** The config dir every account shares; Cortex's own by default. */
  sharedDir?: string;
  /** Where account dirs live. */
  accountsDir?: string;
  platform?: NodeJS.Platform;
}

export function claudeAccountDir(id: string, deps: ClaudeAccountDirDeps = {}): string {
  if (!CONNECTION_ID_RE.test(id)) throw new Error(`Invalid account id: ${id}`);
  return path.join(deps.accountsDir ?? CLAUDE_ACCOUNTS_HOME, id);
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function linkTarget(link: string): string | null {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    return null;
  }
}

/** A real entry the CLI made in place of a link is left alone, except settings, which the CLI may
 *  rewrite by rename: those always come back from the shared copy. */
function clearForLink(target: string, link: string): boolean {
  const current = lstatOrNull(link);
  if (!current) return true;
  if (current.isSymbolicLink()) {
    if (linkTarget(link) === target) return false;
    fs.unlinkSync(link);
    return true;
  }
  if (path.basename(link) !== SETTINGS_FILE) return false;
  fs.rmSync(link, { force: true });
  return true;
}

/** Windows links directories as junctions (no privilege needed); settings fall back to a copy. */
function linkShared(target: string, link: string, directory: boolean, platform: NodeJS.Platform): void {
  if (!clearForLink(target, link)) return;
  const type = directory ? (platform === 'win32' ? 'junction' : 'dir') : 'file';
  try {
    fs.symlinkSync(target, link, type);
  } catch (error) {
    if (path.basename(link) === SETTINGS_FILE) fs.copyFileSync(target, link);
    else log.warn(`Could not link ${link}: ${(error as Error).message}`);
  }
}

/** A link whose shared entry is gone would make the CLI fail where it creates that entry. */
function pruneBrokenLinks(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const link = path.join(dir, entry.name);
    if (entry.isSymbolicLink() && !fs.existsSync(link)) fs.unlinkSync(link);
  }
}

/** Create the account's config dir and bring its links up to date with the shared dir. Cheap
 *  enough to run before every spawn and login. Returns the dir. */
export function ensureClaudeAccountDir(id: string, deps: ClaudeAccountDirDeps = {}): string {
  const dir = claudeAccountDir(id, deps);
  const shared = deps.sharedDir ?? CLAUDE_CONFIG_HOME;
  const platform = deps.platform ?? process.platform;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of SHARED_DIRS) fs.mkdirSync(path.join(shared, name), { recursive: true });
  pruneBrokenLinks(dir);
  for (const entry of fs.readdirSync(shared, { withFileTypes: true })) {
    if (ACCOUNT_OWN.has(entry.name)) continue;
    linkShared(path.join(shared, entry.name), path.join(dir, entry.name), entry.isDirectory(), platform);
  }
  return dir;
}

/** Delete the account's dir. Links are removed first, so nothing behind them is touched. */
export function removeClaudeAccountDir(id: string, deps: ClaudeAccountDirDeps = {}): void {
  const dir = claudeAccountDir(id, deps);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fs.unlinkSync(path.join(dir, entry.name));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
