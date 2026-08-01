// input:  session ids, turn indexes, recorded backup paths
// output: async snapshot restore and cleanup helpers
// pos:    Backend transcript snapshot and restore
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { unlinkSync, readdirSync } from 'fs';
import { copyFile, readdir } from 'node:fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { selectPISessionFilename } from '@core/pi-session-filename.js';

const log = createLogger('session-backup');

/**
 * Derive the Claude Code project directory hash from DATA_DIR.
 * Claude Code encodes project directories by replacing '/' and '.' with '-'.
 * e.g. /home/user/.cortex → -home-user--cortex
 */
function getProjectHash(): string {
  return DATA_DIR.replace(/[\/.]/g, '-');
}

function getProjectDir(): string {
  return path.join(os.homedir(), '.claude', 'projects', getProjectHash());
}

/**
 * Get the path to a Claude Code session JSONL file.
 */
function getSessionFilePath(sessionId: string): string {
  return path.join(getProjectDir(), `${sessionId}.jsonl`);
}

function getBackupPath(sessionId: string, turnIndex: number): string {
  return path.join(getProjectDir(), `${sessionId}.jsonl.turn-${turnIndex}.bak`);
}

// --- PI session file utilities ---

/** PI session directory (matches agent-adapter/pi/agent-dir.ts). */
const PI_SESSIONS_DIR = path.join(DATA_DIR, 'logs', 'sessions-pi');

/** Find a PI transcript from its exact id-bearing filename without opening JSONL bodies. */
async function findPISessionFile(
  sessionId: string,
  sessionDir: string = PI_SESSIONS_DIR,
): Promise<string | null> {
  try {
    const filename = selectPISessionFilename(await readdir(sessionDir), sessionId);
    return filename ? path.join(sessionDir, filename) : null;
  } catch {
    return null;
  }
}

/** Create `<filePath>.turn-<turnIndex>.bak` without blocking the event loop. */
async function backupSessionFile(filePath: string, turnIndex: number): Promise<string | null> {
  const backup = `${filePath}.turn-${turnIndex}.bak`;
  try {
    await copyFile(filePath, backup);
    log.info(`Created backup: turn-${turnIndex} for ${path.basename(filePath)}`);
    return backup;
  } catch (e) {
    if (!isNotFound(e)) log.error(`Failed to create backup:`, (e as Error).message);
    return null;
  }
}

/** Derive the exact transcript path encoded by a recorded turn backup. */
function sessionFileFromBackupPath(backupPath: string, turnIndex: number): string | null {
  const suffix = `.turn-${turnIndex}.bak`;
  if (!backupPath.endsWith(suffix)) return null;
  const filePath = backupPath.slice(0, -suffix.length);
  return filePath.length > 0 ? filePath : null;
}

async function restoreFromPaths(backupPath: string, filePath: string, turnIndex: number): Promise<boolean> {
  try {
    await copyFile(backupPath, filePath);
    log.info(`Restored from backup: turn-${turnIndex} for ${path.basename(filePath)}`);
    return true;
  } catch (e) {
    if (isNotFound(e)) log.warn(`Backup not found: turn-${turnIndex} for ${path.basename(filePath)}`);
    else log.error(`Failed to restore backup:`, (e as Error).message);
    return false;
  }
}

/** Restore from an immutable backup pathname recorded in the conversation ledger. */
async function restoreSessionBackup(backupPath: string, turnIndex: number): Promise<boolean> {
  const filePath = sessionFileFromBackupPath(backupPath, turnIndex);
  return filePath ? restoreFromPaths(backupPath, filePath, turnIndex) : false;
}

/** Restore a session file from a turn backup without blocking the event loop. */
async function restoreSessionFile(filePath: string, turnIndex: number): Promise<boolean> {
  return restoreFromPaths(`${filePath}.turn-${turnIndex}.bak`, filePath, turnIndex);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Delete backups for turns strictly after the given index for a specific session file.
 * Backups are named `<basename>.turn-<N>.bak`.
 */
function cleanupBackupsForFile(filePath: string, afterTurnIndex: number): void {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const prefix = `${basename}.turn-`;
  const suffix = '.bak';
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
      const turnStr = file.slice(prefix.length, -suffix.length);
      const turnIdx = parseInt(turnStr, 10);
      if (!isNaN(turnIdx) && turnIdx > afterTurnIndex) unlinkSync(path.join(dir, file));
    }
  } catch (e) {
    log.error(`cleanupBackupsForFile failed:`, (e as Error).message);
  }
}

function cleanupAllBackupsForFile(filePath: string): void {
  cleanupBackupsForFile(filePath, -1);
}

/**
 * Create a backup of the session file before processing a turn.
 * Returns the backup path, or null if the session file doesn't exist yet.
 */
async function createBackup(sessionId: string, turnIndex: number): Promise<string | null> {
  const sessionFile = getSessionFilePath(sessionId);
  const backup = getBackupPath(sessionId, turnIndex);
  try {
    await copyFile(sessionFile, backup);
    log.info(`Created backup: turn-${turnIndex} for ${sessionId.substring(0, 8)}`);
    return backup;
  } catch (e) {
    if (!isNotFound(e)) log.error(`Failed to create backup:`, (e as Error).message);
    return null;
  }
}

async function restoreBackup(sessionId: string, turnIndex: number): Promise<boolean> {
  const backup = getBackupPath(sessionId, turnIndex);
  const sessionFile = getSessionFilePath(sessionId);
  try {
    await copyFile(backup, sessionFile);
    log.info(`Restored from backup: turn-${turnIndex} for ${sessionId.substring(0, 8)}`);
    return true;
  } catch (e) {
    if (isNotFound(e)) log.warn(`Backup not found: turn-${turnIndex} for ${sessionId.substring(0, 8)}`);
    else log.error(`Failed to restore backup:`, (e as Error).message);
    return false;
  }
}

/**
 * Delete all backup files for a session.
 * Called on !new to clean up.
 */
function cleanupAllBackups(sessionId: string): void {
  const dir = getProjectDir();
  const prefix = `${sessionId}.jsonl.turn-`;
  const suffix = '.bak';
  try {
    const files = readdirSync(dir);
    let count = 0;
    for (const file of files) {
      if (file.startsWith(prefix) && file.endsWith(suffix)) {
        unlinkSync(path.join(dir, file));
        count++;
      }
    }
    if (count > 0) {
      log.info(`Cleaned up ${count} backup(s) for ${sessionId.substring(0, 8)}`);
    }
  } catch (e) {
    log.error(`Cleanup failed:`, (e as Error).message);
  }
}

/**
 * Delete backups for turns strictly after the given index.
 * Called after rollback to remove invalidated backups.
 */
function cleanupBackupsAfter(sessionId: string, afterTurnIndex: number): void {
  const dir = getProjectDir();
  const prefix = `${sessionId}.jsonl.turn-`;
  const suffix = '.bak';
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
      const turnStr = file.slice(prefix.length, -suffix.length);
      const turnIdx = parseInt(turnStr, 10);
      if (!isNaN(turnIdx) && turnIdx > afterTurnIndex) {
        unlinkSync(path.join(dir, file));
      }
    }
  } catch (e) {
    log.error(`cleanupBackupsAfter failed:`, (e as Error).message);
  }
}

export {
  getSessionFilePath,
  createBackup,
  restoreBackup,
  cleanupAllBackups,
  cleanupBackupsAfter,
  getProjectHash,
  // PI session file utilities
  findPISessionFile,
  backupSessionFile,
  restoreSessionFile,
  restoreSessionBackup,
  sessionFileFromBackupPath,
  cleanupBackupsForFile,
  cleanupAllBackupsForFile,
};
