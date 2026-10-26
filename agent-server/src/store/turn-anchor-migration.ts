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

/**
 * Give every turn that has a legacy backup the anchor it stands for. `backupPath` and the backup
 * files are left in place, so retention still removes them with their sessions.
 */
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
