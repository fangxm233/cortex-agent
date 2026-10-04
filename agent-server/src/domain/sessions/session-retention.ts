import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@core/log.js';
import { parsePISessionFilename } from '@core/pi-session-filename.js';
import { effectiveBackendSessionId, type PendingDeletion, type Session, type SessionRegistryRepo, type TurnRecord } from '@store/session-registry-repo.js';
import type { ConversationLedgerRepo } from '@store/conversation-ledger-repo.js';
import type { ConversationHistoryRepo } from '@store/conversation-history-repo.js';
import type { RetentionCandidateRepo } from '@store/retention-candidate-repo.js';
import { sessionTotalsCarry, type SessionTotalsCarryRepo } from '@store/session-totals-repo.js';
import { activeSessionUseIds } from '@domain/sessions/session-use.js';
import { toolImageSessionDir } from '@store/tool-image-files.js';
import type { ClaudeUserSettingsSyncResult } from '@domain/auth/claude-user-settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CAPTURE_PREFIX = 'claude-output-';
/** Pending deletions cleaned and committed per registry append; also the stop-check granularity. */
const DELETE_BATCH_SIZE = 100;
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
  /** Root of the per-session tool-result image directories. Absent ⇒ not swept. */
  toolImagesDir?: string;
}

export interface SessionRetentionDeps {
  retentionDays: number;
  now?: () => number;
  registry: SessionRegistryRepo;
  ledgerRepo: Pick<ConversationLedgerRepo, 'clearBySessionIds'>;
  historyRepo: Pick<ConversationHistoryRepo, 'clearBySessionIds'>;
  /** Per-session cumulative stats carried over from archived executions. Optional so existing
   *  callers and fixtures keep working; absent ⇒ the carry is simply not pruned. */
  sessionTotals?: Pick<SessionTotalsCarryRepo, 'forget'>;
  candidateRepo: Pick<RetentionCandidateRepo, 'mark' | 'isConfirmed' | 'clear'>;
  liveness: RetentionLivenessSnapshot;
  paths: SessionRetentionPaths;
  syncClaudeUserCleanupPeriodDays: (days: number) => Promise<ClaudeUserSettingsSyncResult>;
  /** Aborting stops the sweep at the next batch or file; whatever was not committed stays pending
   *  and is retried by the next sweep. */
  signal?: AbortSignal;
}

export interface SessionRetentionSweepResult {
  registryCommitted: number;
  historyOrphanDeleted: number;
  piOrphanDeleted: number;
  claudeCaptureDeleted: number;
  toolImagesDeleted: number;
  helperChanged: boolean;
  errors: string[];
  /** The signal aborted before the sweep finished. */
  stopped: boolean;
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

  const result: SessionRetentionSweepResult = {
    registryCommitted: 0,
    historyOrphanDeleted: 0,
    piOrphanDeleted: 0,
    claudeCaptureDeleted: 0,
    toolImagesDeleted: 0,
    helperChanged: false,
    errors,
    stopped: false,
  };
  const halted = (): boolean => {
    result.stopped = isStopped(deps);
    return result.stopped;
  };

  result.helperChanged = (await safeClaudeSync(deps, errors)).changed;
  if (halted()) return result;
  result.registryCommitted += await retryPendingDeletes(deps, errors);
  if (halted()) return result;
  // This is the ONE place that must protect in-use sessions: the store's `beginDeleteExpired` no
  // longer keeps a use counter, so the runtime lease set (`@domain/sessions/session-use.ts`) is
  // unioned into the protected ids here before any delete-intent is written.
  const protectedTracks = new Set([...deps.liveness.protectedTrackSessionIds, ...activeSessionUseIds()]);
  const pending = await safeRegistryBeginDeleteExpired(deps, cutoffMs, protectedTracks, errors);
  result.registryCommitted += await commitDeletes(deps, pending, errors);
  if (halted()) return result;

  const live = await safeRegistryListRecentSessions(deps, errors);
  const stillPending = await safeRegistryListPendingDeletions(deps, errors);
  const registryReadable = live.ok && stillPending.ok;
  const protectedBackendIds = new Set(deps.liveness.protectedBackendSessionIds);
  if (registryReadable) {
    result.historyOrphanDeleted = await deleteHistoryOrphans(deps, live.value, stillPending.value, cutoffMs, errors);
    result.piOrphanDeleted = await deletePiOrphans(deps, live.value, stillPending.value, protectedBackendIds, cutoffMs, errors);
    result.toolImagesDeleted = await deleteToolImageOrphans(deps, live.value, stillPending.value, cutoffMs, errors);
  }
  result.claudeCaptureDeleted = await deleteClaudeCaptureLogs(deps, cutoffMs, errors);
  halted();
  return result;
}

function isStopped(deps: SessionRetentionDeps): boolean {
  return deps.signal?.aborted === true;
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
      (session, turns) => prepareDeleteCleanup(deps, session, turns),
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

/**
 * Crash-safety order, per batch: the delete intents are already durable; registry-side cleanup
 * (bindings, conversation + turns) lands in one append; per-session files are removed; only the
 * sessions whose cleanup fully succeeded are committed in one append. Every step is idempotent, so
 * a crash or stop anywhere leaves intents that the next sweep's retry finishes.
 */
async function commitDeletes(
  deps: SessionRetentionDeps,
  entries: PendingDeletion[],
  errors: string[],
): Promise<number> {
  let committed = 0;
  for (let start = 0; start < entries.length && !isStopped(deps); start += DELETE_BATCH_SIZE) {
    committed += await commitDeleteBatch(deps, entries.slice(start, start + DELETE_BATCH_SIZE), errors);
  }
  return committed;
}

async function commitDeleteBatch(
  deps: SessionRetentionDeps,
  entries: PendingDeletion[],
  errors: string[],
): Promise<number> {
  const ids = entries.map(entry => entry.session.sessionId);
  try {
    await deps.registry.unbindBySessionIds(ids);
    await deps.ledgerRepo.clearBySessionIds(ids);
  } catch (error) {
    errors.push(`registry cleanup (${ids.length} sessions): ${(error as Error).message}`);
    return 0;
  }
  const piBundles = await piBundleIndexFor(deps, entries, errors);
  const cleaned: string[] = [];
  for (const entry of entries) {
    try {
      await cleanupSessionFiles(deps, entry, piBundles);
      cleaned.push(entry.session.sessionId);
    } catch (error) {
      errors.push(`${entry.session.sessionId}: ${(error as Error).message}`);
    }
  }
  if (cleaned.length === 0) return 0;
  try {
    // Otherwise the carry would outlive every session it describes and grow without bound.
    await (deps.sessionTotals ?? sessionTotalsCarry).forget(cleaned);
    return (await deps.registry.commitDeletions(cleaned)).length;
  } catch (error) {
    errors.push(`registry commit (${cleaned.length} sessions): ${(error as Error).message}`);
    return 0;
  }
}

/** One directory listing per batch instead of one per PI session. `null` when the listing failed:
 *  the batch's PI sessions then stay pending. */
async function piBundleIndexFor(
  deps: SessionRetentionDeps,
  entries: PendingDeletion[],
  errors: string[],
): Promise<Map<string, string[]> | null> {
  if (!entries.some(entry => entry.session.backend === 'pi')) return new Map();
  try {
    return await collectPiBundleIndex(deps.paths.piSessionsDir);
  } catch (error) {
    errors.push(`pi-bundles: ${(error as Error).message}`);
    return null;
  }
}

async function prepareDeleteCleanup(
  deps: SessionRetentionDeps,
  session: Session,
  turns: TurnRecord[],
): Promise<PendingDeletion['cleanup']> {
  if (session.backend !== 'claude') return { claudeBackupPaths: [] };
  const backendId = effectiveBackendSessionId(session);
  if (!backendId) return { claudeBackupPaths: [] };
  const candidates = turns.map(turn => turn.backupPath);
  return {
    claudeBackupPaths: await trustedClaudeBackupPaths(deps.paths.claudeProjectDir, backendId, candidates),
  };
}

async function cleanupSessionFiles(
  deps: SessionRetentionDeps,
  entry: PendingDeletion,
  piBundles: Map<string, string[]> | null,
): Promise<void> {
  const session = entry.session;
  const backendId = effectiveBackendSessionId(session);
  await deps.historyRepo.clearBySessionIds([session.sessionId]);
  if (backendId && session.backend === 'pi') {
    if (!piBundles) throw new Error('PI transcript directory could not be listed');
    await deleteFiles(piBundles.get(backendId) ?? []);
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
    if (isStopped(deps)) break;
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

/** A session's tool-image directory outlives nothing: once the session is neither live nor pending
 *  deletion its images have no transcript left to show them. The mtime guard mirrors the history
 *  sweep — a directory written inside the retention window is never touched. */
async function deleteToolImageOrphans(
  deps: SessionRetentionDeps,
  live: Session[],
  pending: PendingDeletion[],
  cutoffMs: number,
  errors: string[],
): Promise<number> {
  const root = deps.paths.toolImagesDir;
  if (!root) return 0;
  const keep = new Set([...live, ...pending.map(entry => entry.session)]
    .map(session => toolImageSessionDir(session.sessionId)));
  let names: string[];
  try {
    names = await readDirSafe(root);
  } catch (error) {
    errors.push(`tool-images: ${(error as Error).message}`);
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (isStopped(deps)) break;
    if (keep.has(name)) continue;
    const dir = path.join(root, name);
    try {
      const entry = await safeLstat(dir);
      if (!entry || !entry.isDirectory() || entry.mtimeMs >= cutoffMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      errors.push(`tool-images:${name}: ${(error as Error).message}`);
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
    if (isStopped(deps)) break;
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
    if (isStopped(deps)) break;
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

/** backend session id → its transcript files (primary + turn backups). */
async function collectPiBundleIndex(piDir: string): Promise<Map<string, string[]>> {
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
  return byId;
}

async function collectPiBundles(piDir: string): Promise<PiBundle[]> {
  const byId = await collectPiBundleIndex(piDir);
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
