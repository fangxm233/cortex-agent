import type { Dirent } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '@core/log.js';
import { lastEntryId } from '@core/transcript-anchor.js';
import type { TurnAnchor } from '@core/types/transcript-anchor.js';
import { relocateLegacyClaudePath } from './claude-transcript-migration.js';
import { SessionRegistryRepo } from './session-registry-repo.js';
import type { TurnRecord } from './session-registry-journal.js';

const log = createLogger('turn-anchor-migration');
const BACKUP_SUFFIX = /\.turn-\d+\.bak$/;

/**
 * The anchor a legacy turn backup stands for. The backup is the transcript as it was when the turn
 * began, so its last entry is where the turn starts in the live transcript. Null when the backup is
 * gone, holds no entry, or is not named like a turn backup.
 */
export async function anchorFromBackup(backupPath: string): Promise<TurnAnchor | null> {
  const backup = relocateLegacyClaudePath(backupPath);
  const file = backup.replace(BACKUP_SUFFIX, '');
  if (file === backup) return null;
  try {
    const id = await lastEntryId(backup);
    return id ? { file, after: id } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface TurnAnchorMigrationReport {
  converted: number;
  /** Turns whose backup was already gone: they can no longer be rewound to. */
  missing: number;
}

async function anchorsFor(turns: TurnRecord[], report: TurnAnchorMigrationReport): Promise<Map<number, TurnAnchor>> {
  const anchors = new Map<number, TurnAnchor>();
  for (const turn of turns) {
    if (!turn.backupPath || turn.anchor) continue;
    const anchor = await anchorFromBackup(turn.backupPath);
    if (anchor) anchors.set(turn.turnIndex, anchor);
    else report.missing++;
  }
  report.converted += anchors.size;
  return anchors;
}

/** Give every turn that has a legacy backup the anchor it stands for. The backups are left in
 *  place; `removeTurnBackups` deletes them once every conversation is anchored. */
export async function migrateTurnBackupsToAnchors(storeDir: string): Promise<TurnAnchorMigrationReport> {
  const registry = new SessionRegistryRepo(path.join(storeDir, 'session-registry.jsonl'));
  const report: TurnAnchorMigrationReport = { converted: 0, missing: 0 };
  for (const { channel, turns } of await registry.listConversations()) {
    const anchors = await anchorsFor(turns, report);
    if (anchors.size === 0) continue;
    await registry.batch(async (ops) => {
      for (const [turnIndex, anchor] of anchors) await ops.patchTurn(channel, turnIndex, { anchor });
    });
  }
  await registry.flush();
  log.info(`Turn backups converted to anchors: ${JSON.stringify(report)}`);
  return report;
}

const TURN_BACKUP_FILE = /\.jsonl\.turn-\d+\.bak$/;

function isTurnBackup(entry: Dirent): boolean {
  return entry.isFile() && TURN_BACKUP_FILE.test(entry.name);
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Turn backups directly in `dir` or one level below it (Claude keeps a folder per project). */
async function turnBackupsIn(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (isTurnBackup(entry)) found.push(full);
    if (!entry.isDirectory()) continue;
    for (const child of await listDir(full)) if (isTurnBackup(child)) found.push(path.join(full, child.name));
  }
  return found;
}

export interface TurnBackupRemovalReport {
  removed: number;
  /** Backups that could not be deleted; logged and left in place. */
  failed: number;
}

async function removeOne(file: string, report: TurnBackupRemovalReport): Promise<void> {
  try {
    await unlink(file);
    report.removed++;
  } catch (error) {
    report.failed++;
    log.warn(`Could not remove turn backup ${file}: ${(error as Error).message}`);
  }
}

/** Delete every legacy turn backup (`<transcript>.jsonl.turn-N.bak`) under `dirs`. Rewinds cut the
 *  transcript at the turn's anchor, so nothing reads the backups. */
export async function removeTurnBackups(dirs: string[]): Promise<TurnBackupRemovalReport> {
  const report: TurnBackupRemovalReport = { removed: 0, failed: 0 };
  for (const dir of dirs) {
    for (const file of await turnBackupsIn(dir)) await removeOne(file, report);
  }
  log.info(`Turn backups removed: ${JSON.stringify(report)}`);
  return report;
}

/** Anchor every backed-up turn, then delete the backups in Cortex's PI and Claude transcript dirs.
 *  A conversion that throws stops before anything is deleted. */
export async function retireTurnBackups(dataDir: string, storeDir: string): Promise<void> {
  await migrateTurnBackupsToAnchors(storeDir);
  await removeTurnBackups([path.join(dataDir, 'logs', 'sessions-pi'), path.join(storeDir, 'claude', 'projects')]);
}
