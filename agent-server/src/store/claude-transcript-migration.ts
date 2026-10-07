import fs from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_CONFIG_HOME, USER_CLAUDE_CONFIG_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { effectiveBackendSessionId, SessionRegistryRepo } from './session-registry-repo.js';

const log = createLogger('claude-transcript-migration');
const REGISTRY_FILE = 'session-registry.jsonl';

/** `<id>.jsonl`, Cortex's `<id>.jsonl.turn-<N>.bak` backups of it, and the `<id>/` sidecar
 *  directory (subagents, tool results) all belong to backend session `<id>`. */
const OWNED_ENTRY = /^(.+?)(?:\.jsonl(?:\.turn-\d+\.bak)?)?$/;

export interface ClaudeTranscriptMigrationPaths {
  /** `projects/` of the config dir Cortex used to share with the terminal. */
  legacyProjectsDir: string;
  /** `projects/` of Cortex's own config dir. */
  projectsDir: string;
}

export interface ClaudeTranscriptMove {
  from: string;
  to: string;
}

export interface ClaudeTranscriptMigrationResult {
  moved: number;
  /** The destination already existed; the source was left where it was. */
  skipped: number;
  failed: number;
}

const DEFAULT_PATHS: ClaudeTranscriptMigrationPaths = {
  legacyProjectsDir: path.join(USER_CLAUDE_CONFIG_DIR, 'projects'),
  projectsDir: path.join(CLAUDE_CONFIG_HOME, 'projects'),
};

/** A path Cortex recorded under the shared `~/.claude/projects` (a turn backup), mapped to where
 *  the migration moved it. Any other path comes back unchanged. */
export function relocateLegacyClaudePath(
  filePath: string,
  paths: ClaudeTranscriptMigrationPaths = DEFAULT_PATHS,
): string {
  const relative = path.relative(paths.legacyProjectsDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return filePath;
  return path.join(paths.projectsDir, relative);
}

async function readDirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

async function claudeBackendIds(registry: Pick<SessionRegistryRepo, 'listRecentSessions'>): Promise<Set<string>> {
  const sessions = await registry.listRecentSessions(Number.MAX_SAFE_INTEGER);
  const ids = sessions
    .filter(session => session.backend === 'claude')
    .map(session => effectiveBackendSessionId(session));
  return new Set(ids.filter((id): id is string => !!id));
}

/** Every entry under any project dir (one per encoded cwd) that a session in `ids` owns. */
export async function planClaudeTranscriptMoves(
  ids: ReadonlySet<string>,
  paths: ClaudeTranscriptMigrationPaths,
): Promise<ClaudeTranscriptMove[]> {
  if (ids.size === 0) return [];
  const moves: ClaudeTranscriptMove[] = [];
  for (const project of await readDirOrEmpty(paths.legacyProjectsDir)) {
    const dir = path.join(paths.legacyProjectsDir, project);
    for (const name of await readDirOrEmpty(dir)) {
      if (!ids.has(OWNED_ENTRY.exec(name)![1])) continue;
      moves.push({ from: path.join(dir, name), to: path.join(paths.projectsDir, project, name) });
    }
  }
  return moves;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** rename, or copy-then-delete when the two dirs sit on different filesystems. Never overwrites:
 *  a destination that exists already belongs to a session that has run since. */
async function moveEntry(move: ClaudeTranscriptMove): Promise<'moved' | 'skipped'> {
  if (await exists(move.to)) return 'skipped';
  await fs.mkdir(path.dirname(move.to), { recursive: true });
  try {
    await fs.rename(move.from, move.to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.cp(move.from, move.to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await fs.rm(move.from, { recursive: true, force: true });
  }
  return 'moved';
}

/**
 * Move the Claude files of every live claude session in the registry from the shared
 * `~/.claude/projects` into Cortex's own config dir, keeping each one's encoded-cwd subdirectory so
 * `--resume` finds it. Files no registry session owns are the user's terminal sessions and stay.
 * A file that fails is logged and left behind; it never stops the rest or the boot.
 */
export async function migrateClaudeTranscripts(
  registry: Pick<SessionRegistryRepo, 'listRecentSessions'>,
  paths: ClaudeTranscriptMigrationPaths = DEFAULT_PATHS,
): Promise<ClaudeTranscriptMigrationResult> {
  const result: ClaudeTranscriptMigrationResult = { moved: 0, skipped: 0, failed: 0 };
  if (path.resolve(paths.legacyProjectsDir) === path.resolve(paths.projectsDir)) return result;
  for (const move of await planClaudeTranscriptMoves(await claudeBackendIds(registry), paths)) {
    try {
      const outcome = await moveEntry(move);
      result[outcome] += 1;
      if (outcome === 'skipped') log.warn(`Kept ${move.from}: ${move.to} already exists`);
    } catch (error) {
      result.failed += 1;
      log.warn(`Could not move ${move.from}: ${(error as Error).message}`);
    }
  }
  log.info(`Claude transcripts moved=${result.moved} skipped=${result.skipped} failed=${result.failed}`);
  return result;
}

/** The boot step: the registry and Cortex's config dir both live under `storeDir`. A store with no
 *  registry has no sessions to move, and loading one would create it. */
export async function migrateClaudeConfigHome(
  storeDir: string,
  legacyProjectsDir: string = DEFAULT_PATHS.legacyProjectsDir,
): Promise<ClaudeTranscriptMigrationResult> {
  const registryFile = path.join(storeDir, REGISTRY_FILE);
  if (!await exists(registryFile)) return { moved: 0, skipped: 0, failed: 0 };
  return migrateClaudeTranscripts(new SessionRegistryRepo(registryFile), {
    legacyProjectsDir,
    projectsDir: path.join(storeDir, 'claude', 'projects'),
  });
}
