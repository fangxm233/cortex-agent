// input:  registry/session stores, filesystem paths, liveness snapshot
// output: runSessionRetentionSweep and retention DTOs
// pos:    Session retention coordinator shared by startup and periodic sweeps
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@core/log.js';
import { parsePISessionFilename } from '@core/pi-session-filename.js';
import { effectiveBackendSessionId, type PendingDeletion, type Session, type SessionRegistryRepo } from '@store/session-registry-repo.js';
import type { SessionRepo } from '@store/session-repo.js';
import type { ConversationLedgerRepo } from '@store/conversation-ledger-repo.js';
import type { ConversationHistoryRepo } from '@store/conversation-history-repo.js';
import type { RetentionCandidateRepo } from '@store/retention-candidate-repo.js';
import type { ClaudeUserSettingsSyncResult } from '@domain/auth/claude-user-settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CAPTURE_PREFIX = 'claude-output-';
const log = createLogger('session-retention');

export interface RetentionLivenessSnapshot {
  protectedTrackSessionIds: string[];
  protectedBackendSessionIds: string[];
  activeClaudeCapturePaths: string[];
  activeClaudeCapturePairs: string[];
}

export interface SessionRetentionPaths {
  historyDir: string;
  piSessionsDir: string;
  claudeCaptureDir: string;
  claudeProjectDir: string;
}

export interface SessionRetentionDeps {
  retentionDays: number;
  now?: () => number;
  registry: SessionRegistryRepo;
  sessionRepo: Pick<SessionRepo, 'deleteManyBySessionIds' | 'deleteExceptSessionIds'>;
  ledgerRepo: Pick<ConversationLedgerRepo, 'listBySessionIds' | 'clearBySessionIds' | 'deleteExceptSessionIds'>;
  historyRepo: Pick<ConversationHistoryRepo, 'clearBySessionIds'>;
  candidateRepo: Pick<RetentionCandidateRepo, 'mark' | 'isConfirmed' | 'clear' | 'clearCategory'>;
  liveness: RetentionLivenessSnapshot;
  paths: SessionRetentionPaths;
  syncClaudeUserCleanupPeriodDays: (days: number) => Promise<ClaudeUserSettingsSyncResult>;
}

export interface SessionRetentionSweepResult {
  registryCommitted: number;
  historyOrphanDeleted: number;
  piOrphanDeleted: number;
  claudeCaptureDeleted: number;
  helperChanged: boolean;
  errors: string[];
}

interface PiBundle {
  backendSessionId: string;
  files: string[];
  newestMtimeMs: number;
}

interface CaptureGroup {
  pairKey: string;
  files: string[];
  newestMtimeMs: number;
}

interface RegistryRead<T> {
  ok: boolean;
  value: T;
}

export async function runSessionRetentionSweep(deps: SessionRetentionDeps): Promise<SessionRetentionSweepResult> {
  const errors: string[] = [];
  const now = deps.now ?? Date.now;
  const cutoffMs = now() - deps.retentionDays * DAY_MS;

  const helper = await safeClaudeSync(deps, errors);
  const committed = await retryPendingDeletes(deps, errors);
  const protectedTracks = new Set(deps.liveness.protectedTrackSessionIds);
  const pending = await safeRegistryBeginDeleteExpired(deps, cutoffMs, protectedTracks, errors);
  const newlyCommitted = await commitDeletes(deps, pending, errors);
  const registryCommitted = committed + newlyCommitted;

  const live = await safeRegistryListRecentSessions(deps, errors);
  const stillPending = await safeRegistryListPendingDeletions(deps, errors);
  const registryReadable = live.ok && stillPending.ok;
  if (registryReadable) {
    await repairDanglingReferences(deps, live.value, stillPending.value, errors);
  }
  const protectedBackendIds = new Set(deps.liveness.protectedBackendSessionIds);
  const historyOrphanDeleted = registryReadable
    ? await deleteHistoryOrphans(deps, live.value, stillPending.value, cutoffMs, errors)
    : 0;
  const piOrphanDeleted = registryReadable
    ? await deletePiOrphans(deps, live.value, stillPending.value, protectedBackendIds, cutoffMs, errors)
    : 0;
  const claudeCaptureDeleted = await deleteClaudeCaptureLogs(deps, cutoffMs, errors);

  return {
    registryCommitted,
    historyOrphanDeleted,
    piOrphanDeleted,
    claudeCaptureDeleted,
    helperChanged: helper.changed,
    errors,
  };
}

async function retryPendingDeletes(deps: SessionRetentionDeps, errors: string[]): Promise<number> {
  return commitDeletes(deps, (await safeRegistryListPendingDeletions(deps, errors)).value, errors);
}

async function safeClaudeSync(
  deps: SessionRetentionDeps,
  errors: string[],
): Promise<ClaudeUserSettingsSyncResult> {
  try {
    return await deps.syncClaudeUserCleanupPeriodDays(deps.retentionDays);
  } catch (error) {
    const message = `claude-helper: ${(error as Error).message}`;
    errors.push(message);
    log.warn(message);
    return { filePath: '', changed: false };
  }
}

async function safeRegistryBeginDeleteExpired(
  deps: SessionRetentionDeps,
  cutoffMs: number,
  protectedTracks: Set<string>,
  errors: string[],
): Promise<PendingDeletion[]> {
  try {
    return await deps.registry.beginDeleteExpired(
      cutoffMs,
      protectedTracks,
      session => prepareDeleteCleanup(deps, session),
    );
  } catch (error) {
    errors.push(`registry.beginDeleteExpired: ${(error as Error).message}`);
    return [];
  }
}

async function safeRegistryListRecentSessions(
  deps: SessionRetentionDeps,
  errors: string[],
): Promise<RegistryRead<Session[]>> {
  try {
    return { ok: true, value: await deps.registry.listRecentSessions(Number.MAX_SAFE_INTEGER) };
  } catch (error) {
    errors.push(`registry.listRecentSessions: ${(error as Error).message}`);
    return { ok: false, value: [] };
  }
}

async function safeRegistryListPendingDeletions(
  deps: SessionRetentionDeps,
  errors: string[],
): Promise<RegistryRead<PendingDeletion[]>> {
  try {
    return { ok: true, value: await deps.registry.listPendingDeletions() };
  } catch (error) {
    errors.push(`registry.listPendingDeletions: ${(error as Error).message}`);
    return { ok: false, value: [] };
  }
}

async function commitDeletes(
  deps: SessionRetentionDeps,
  entries: PendingDeletion[],
  errors: string[],
): Promise<number> {
  let committed = 0;
  for (const entry of entries) {
    try {
      await cleanupPendingDelete(deps, entry);
      if (await deps.registry.commitDeletion(entry.session.sessionId)) committed += 1;
    } catch (error) {
      errors.push(`${entry.session.sessionId}: ${(error as Error).message}`);
    }
  }
  return committed;
}

async function prepareDeleteCleanup(
  deps: SessionRetentionDeps,
  session: Session,
): Promise<PendingDeletion['cleanup']> {
  if (session.backend !== 'claude') return { claudeBackupPaths: [] };
  const backendId = effectiveBackendSessionId(session);
  if (!backendId) return { claudeBackupPaths: [] };
  const ledgerRows = await deps.ledgerRepo.listBySessionIds([session.sessionId]);
  const candidates = ledgerRows.flatMap(row => row.turns.map(turn => turn.backupPath));
  return {
    claudeBackupPaths: await trustedClaudeBackupPaths(deps.paths.claudeProjectDir, backendId, candidates),
  };
}

async function cleanupPendingDelete(deps: SessionRetentionDeps, entry: PendingDeletion): Promise<void> {
  const session = entry.session;
  const backendId = effectiveBackendSessionId(session);
  await deps.sessionRepo.deleteManyBySessionIds([session.sessionId]);
  await deps.ledgerRepo.clearBySessionIds([session.sessionId]);
  await deps.historyRepo.clearBySessionIds([session.sessionId]);
  if (backendId && session.backend === 'pi') {
    await deleteFiles(await collectPiBundleFiles(deps.paths.piSessionsDir, backendId));
  }
  await deleteFiles(entry.cleanup.claudeBackupPaths);
}

async function trustedClaudeBackupPaths(
  rootDir: string,
  backendSessionId: string,
  candidates: Array<string | null>,
): Promise<string[]> {
  const root = await realpathOrNull(rootDir);
  if (!root) return [];
  const trusted: string[] = [];
  const expected = new RegExp(`^${escapeRegExp(backendSessionId)}\\.jsonl\\.turn-\\d+\\.bak$`);
  for (const candidate of candidates) {
    if (!candidate || !expected.test(path.basename(candidate))) continue;
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== path.resolve(rootDir)) continue;
    const entry = await safeLstat(resolved);
    if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
    const real = await realpathOrNull(resolved);
    if (!real || path.dirname(real) !== root) continue;
    trusted.push(resolved);
  }
  return [...new Set(trusted)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function realpathOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function repairDanglingReferences(
  deps: SessionRetentionDeps,
  live: Session[],
  pending: PendingDeletion[],
  errors: string[],
): Promise<void> {
  const liveIds = new Set(live.map((session) => session.sessionId));
  for (const entry of pending) liveIds.add(entry.session.sessionId);
  try {
    await deps.sessionRepo.deleteExceptSessionIds(liveIds);
  } catch (error) {
    errors.push(`bindings-repair: ${(error as Error).message}`);
  }
  try {
    await deps.ledgerRepo.deleteExceptSessionIds(liveIds);
  } catch (error) {
    errors.push(`ledger-repair: ${(error as Error).message}`);
  }
}

async function deleteHistoryOrphans(
  deps: SessionRetentionDeps,
  live: Session[],
  pending: PendingDeletion[],
  cutoffMs: number,
  errors: string[],
): Promise<number> {
  const protectedIds = new Set([
    ...live.map(session => session.sessionId),
    ...pending.map(entry => entry.session.sessionId),
  ]);
  const files = await listFiles(deps.paths.historyDir, '.jsonl');
  let removed = 0;
  for (const filePath of files) {
    const sessionId = path.basename(filePath, '.jsonl');
    try {
      if (protectedIds.has(sessionId)) {
        await deps.candidateRepo.clear('history', sessionId);
        continue;
      }
      const stats = await safeStat(filePath);
      if (!stats || stats.mtimeMs >= cutoffMs) {
        await deps.candidateRepo.clear('history', sessionId);
        continue;
      }
      const stamp = Number(stats.mtimeMs);
      if (!await deps.candidateRepo.isConfirmed('history', sessionId, stamp)) {
        await deps.candidateRepo.mark('history', sessionId, stamp);
        continue;
      }
      await unlinkIfExists(filePath);
      await deps.candidateRepo.clear('history', sessionId);
      removed += 1;
    } catch (error) {
      errors.push(`history:${sessionId}: ${(error as Error).message}`);
    }
  }
  return removed;
}

async function deletePiOrphans(
  deps: SessionRetentionDeps,
  live: Session[],
  pending: PendingDeletion[],
  protectedBackendIds: Set<string>,
  cutoffMs: number,
  errors: string[],
): Promise<number> {
  const tracked = new Set<string>();
  for (const session of [...live, ...pending.map(entry => entry.session)]) {
    const backendId = effectiveBackendSessionId(session);
    if (backendId) tracked.add(backendId);
  }
  const bundles = await collectPiBundles(deps.paths.piSessionsDir);
  let removed = 0;
  for (const bundle of bundles) {
    try {
      if (tracked.has(bundle.backendSessionId) || protectedBackendIds.has(bundle.backendSessionId)) {
        await deps.candidateRepo.clear('pi', bundle.backendSessionId);
        continue;
      }
      if (bundle.newestMtimeMs >= cutoffMs) {
        await deps.candidateRepo.clear('pi', bundle.backendSessionId);
        continue;
      }
      if (!await deps.candidateRepo.isConfirmed('pi', bundle.backendSessionId, bundle.newestMtimeMs)) {
        await deps.candidateRepo.mark('pi', bundle.backendSessionId, bundle.newestMtimeMs);
        continue;
      }
      removed += await deleteFiles(bundle.files);
      await deps.candidateRepo.clear('pi', bundle.backendSessionId);
    } catch (error) {
      errors.push(`pi:${bundle.backendSessionId}: ${(error as Error).message}`);
    }
  }
  return removed;
}

async function deleteClaudeCaptureLogs(deps: SessionRetentionDeps, cutoffMs: number, errors: string[]): Promise<number> {
  const activePaths = new Set(deps.liveness.activeClaudeCapturePaths.map((value) => path.resolve(value)));
  const activePairs = new Set(deps.liveness.activeClaudeCapturePairs);
  const groups = await collectCaptureGroups(deps.paths.claudeCaptureDir);
  let removed = 0;
  for (const group of groups) {
    try {
      if (group.newestMtimeMs >= cutoffMs || activePairs.has(group.pairKey)) continue;
      if (group.files.some((filePath) => activePaths.has(path.resolve(filePath)))) continue;
      removed += await deleteFiles(group.files);
    } catch (error) {
      errors.push(`capture:${group.pairKey}: ${(error as Error).message}`);
    }
  }
  return removed;
}

async function collectPiBundleFiles(piDir: string, backendSessionId: string): Promise<string[]> {
  const bundles = await collectPiBundles(piDir);
  return bundles.find((bundle) => bundle.backendSessionId === backendSessionId)?.files ?? [];
}

async function collectPiBundles(piDir: string): Promise<PiBundle[]> {
  const names = await readDirSafe(piDir);
  const byId = new Map<string, string[]>();
  for (const name of names) {
    const backendSessionId = parsePiBackendSessionId(name);
    if (!backendSessionId) continue;
    const filePath = path.join(piDir, name);
    const files = byId.get(backendSessionId) ?? [];
    files.push(filePath);
    byId.set(backendSessionId, files);
  }
  const bundles: PiBundle[] = [];
  for (const [backendSessionId, files] of byId) {
    bundles.push({
      backendSessionId,
      files,
      newestMtimeMs: await newestMtime(files),
    });
  }
  return bundles;
}

function parsePiBackendSessionId(name: string): string | null {
  return parsePISessionFilename(name)?.sessionId ?? null;
}

async function collectCaptureGroups(dir: string): Promise<CaptureGroup[]> {
  const names = await readDirSafe(dir);
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const pairKey = parseCapturePair(name);
    if (!pairKey) continue;
    const files = groups.get(pairKey) ?? [];
    files.push(path.join(dir, name));
    groups.set(pairKey, files);
  }
  const out: CaptureGroup[] = [];
  for (const [pairKey, files] of groups) {
    out.push({ pairKey, files, newestMtimeMs: await newestMtime(files) });
  }
  return out;
}

function parseCapturePair(name: string): string | null {
  if (!name.startsWith(CAPTURE_PREFIX)) return null;
  if (!name.endsWith('.jsonl') && !name.endsWith('.txt')) return null;
  return name.slice(CAPTURE_PREFIX.length).replace(/\.(jsonl|txt)$/, '');
}

async function newestMtime(files: string[]): Promise<number> {
  let newest = 0;
  for (const filePath of files) {
    const stats = await safeStat(filePath);
    if (stats) newest = Math.max(newest, Number(stats.mtimeMs));
  }
  return newest;
}

async function deleteFiles(files: string[]): Promise<number> {
  let removed = 0;
  for (const filePath of files) {
    removed += await unlinkIfExists(filePath);
  }
  return removed;
}

async function unlinkIfExists(filePath: string): Promise<number> {
  const entry = await safeLstat(filePath);
  if (!entry) return 0;
  if (entry.isSymbolicLink()) throw new Error(`refusing to unlink symlink: ${filePath}`);
  if (!entry.isFile()) throw new Error(`refusing to unlink non-regular file: ${filePath}`);
  try {
    await fs.unlink(filePath);
    return 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const names = await readDirSafe(dir);
  return names.filter((name) => name.endsWith(suffix)).map((name) => path.join(dir, name));
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function safeStat(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  const entry = await safeLstat(filePath);
  if (!entry) return null;
  if (entry.isSymbolicLink()) return null;
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function safeLstat(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
