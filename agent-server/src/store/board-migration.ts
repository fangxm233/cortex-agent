// Retire commissions in favour of boards (install migration). Everything is moved or rewritten in
// place, never deleted: the commission registry becomes boards.json (the original kept as
// `.pre-<version>.bak`), registered commission directories move from `commissions/<slug>` to
// `boards/<slug>` with their files untouched, unregistered `_draft-*` directories stay where they
// are, and the session journal is compacted so its records carry the board fields. Idempotent.

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { atomicWrite } from '@core/atomic-write.js';
import { createLogger } from '@core/log.js';
import { SessionRegistryRepo } from './session-registry-repo.js';
import type { BoardRecord, BoardsData } from './board-repo.js';

const log = createLogger('board-migration');

const LEGACY_SESSION_KEYS = ['"commissionId"', '"commissionDraft"', '"commissionBlockFor"'];
const LEGACY_PLUGIN = 'plugins/cortex-commission';
const BOARD_PLUGIN = 'plugins/cortex-board';

export interface RetireCommissionsOptions {
  dataDir: string;
  storeDir: string;
  /** Where project context directories live (`<projectsDir>/<projectId>`). */
  projectsDir: string;
  version: string;
  now?: Date;
}

export interface RetireCommissionsReport {
  commissionsFound: number;
  boardsAdded: number;
  dirsMoved: number;
  dirConflicts: number;
  draftsLeft: number;
  sessionsMapped: number;
  journalCompacted: boolean;
  settingsStripped: boolean;
  environmentsUpdated: number;
  pluginArchived: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A commission as a board. A commission's status and close note have no board counterpart. */
function toBoard(raw: unknown): BoardRecord | null {
  if (!isRecord(raw)) return null;
  const { id, projectId, slug, title, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || typeof projectId !== 'string' || typeof slug !== 'string') return null;
  return {
    id, projectId, slug,
    title: typeof title === 'string' ? title : slug,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  };
}

/** commissions.json → boards.json (merged by id), the source renamed to `.pre-<version>.bak`. */
async function migrateRegistry(opts: RetireCommissionsOptions, report: RetireCommissionsReport): Promise<void> {
  const source = path.join(opts.storeDir, 'commissions.json');
  const raw = await readJson(source);
  if (raw === undefined) return;
  const commissions = isRecord(raw) && Array.isArray(raw.commissions) ? raw.commissions : [];
  report.commissionsFound = commissions.length;

  const target = path.join(opts.storeDir, 'boards.json');
  const existing = await readJson(target);
  const data: BoardsData = isRecord(existing) && Array.isArray(existing.boards)
    ? existing as unknown as BoardsData : { boards: [] };
  const known = new Set(data.boards.map(b => b.id));
  for (const entry of commissions) {
    const board = toBoard(entry);
    if (!board || known.has(board.id)) continue;
    data.boards.push(board);
    known.add(board.id);
    report.boardsAdded += 1;
  }
  await atomicWrite(target, `${JSON.stringify(data, null, 2)}\n`);

  const backup = `${source}.pre-${opts.version}.bak`;
  if (await exists(backup)) throw new Error(`backup already exists: ${backup}`);
  await fs.rename(source, backup);
  log.info(`Converted ${source} -> ${target} (${report.boardsAdded} board(s)); original kept at ${backup}`);
}

/** Move `<ctx>/commissions/<slug>` to `<ctx>/boards/<slug>` for every registered board. Driven by
 *  boards.json so a run interrupted after the registry step still finishes the moves. */
async function moveDirectories(opts: RetireCommissionsOptions, report: RetireCommissionsReport): Promise<void> {
  const data = await readJson(path.join(opts.storeDir, 'boards.json'));
  const boards = isRecord(data) && Array.isArray(data.boards) ? data.boards.map(toBoard).filter(b => b !== null) : [];
  const projects = new Set<string>();
  for (const board of boards) {
    projects.add(board.projectId);
    const contextDir = path.join(opts.projectsDir, board.projectId);
    const from = path.join(contextDir, 'commissions', board.slug);
    const to = path.join(contextDir, 'boards', board.slug);
    if (!await exists(from)) continue;
    if (await exists(to)) {
      report.dirConflicts += 1;
      log.warn(`Leaving ${from} in place: ${to} already exists`);
      continue;
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    report.dirsMoved += 1;
    log.info(`Moved ${from} -> ${to}`);
  }
  // Drafts were never registered; they stay as inert files.
  const entries = await fs.readdir(opts.projectsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const drafts = await fs.readdir(path.join(opts.projectsDir, entry.name, 'commissions')).catch(() => [] as string[]);
    report.draftsLeft += drafts.filter(name => name.startsWith('_draft-')).length;
  }
}

/** Rewrite the session journal once if it still names commission fields; replay already maps them
 *  (session-registry-journal), compaction writes the mapped records back out. */
async function compactLegacyJournal(opts: RetireCommissionsOptions, report: RetireCommissionsReport): Promise<void> {
  const file = path.join(opts.storeDir, 'session-registry.jsonl');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!LEGACY_SESSION_KEYS.some(key => text.includes(key))) return;
  const mapped = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.includes('"commissionId"')) continue;
    try {
      const row = JSON.parse(line);
      const value = row?.record?.commissionId ?? row?.fields?.commissionId;
      if (typeof row?.id === 'string' && typeof value === 'string' && value) mapped.add(row.id);
    } catch { /* replay reports malformed lines */ }
  }
  report.sessionsMapped = mapped.size;
  await new SessionRegistryRepo(file).compactNow();
  report.journalCompacted = true;
  log.info(`Compacted ${file}: ${mapped.size} session(s) carry a board binding from their commission`);
}

async function stripSetting(dataDir: string, report: RetireCommissionsReport): Promise<void> {
  const file = path.join(dataDir, 'config', 'settings.json');
  let settings: unknown;
  try {
    settings = await readJson(file);
  } catch {
    log.warn(`Leaving ${file} alone: not valid JSON`);
    return;
  }
  if (!isRecord(settings) || !Object.hasOwn(settings, 'commissionEnabled')) return;
  delete settings.commissionEnabled;
  await atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
  report.settingsStripped = true;
}

/** Environments that loaded cortex-commission load cortex-board instead. */
async function swapEnvironmentPlugins(dataDir: string, report: RetireCommissionsReport): Promise<void> {
  const dir = path.join(dataDir, 'config', 'environments');
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of files.filter(f => f.endsWith('.json'))) {
    const file = path.join(dir, name);
    let env: unknown;
    try {
      env = await readJson(file);
    } catch {
      log.warn(`Leaving ${file} alone: not valid JSON`);
      continue;
    }
    if (!isRecord(env) || !Array.isArray(env.pluginDirs) || !env.pluginDirs.includes(LEGACY_PLUGIN)) continue;
    const dirs = env.pluginDirs as unknown[];
    env.pluginDirs = dirs.includes(BOARD_PLUGIN)
      ? dirs.filter(d => d !== LEGACY_PLUGIN)
      : dirs.map(d => (d === LEGACY_PLUGIN ? BOARD_PLUGIN : d));
    await atomicWrite(file, `${JSON.stringify(env, null, 2)}\n`);
    report.environmentsUpdated += 1;
  }
}

/** The deployed cortex-commission plugin no longer ships; move it under config/archive/. */
async function archivePlugin(opts: RetireCommissionsOptions, report: RetireCommissionsReport): Promise<void> {
  const source = path.join(opts.dataDir, 'plugins', 'cortex-commission');
  if (!await exists(source)) return;
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = path.join(opts.dataDir, 'config', 'archive', `retired-commission-${stamp}`, 'cortex-commission');
  if (await exists(target)) throw new Error(`archive target already exists: ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(source, target);
  report.pluginArchived = true;
  log.info(`Archived ${source} -> ${target}`);
}

export async function retireCommissions(opts: RetireCommissionsOptions): Promise<RetireCommissionsReport> {
  const report: RetireCommissionsReport = {
    commissionsFound: 0, boardsAdded: 0, dirsMoved: 0, dirConflicts: 0, draftsLeft: 0,
    sessionsMapped: 0, journalCompacted: false, settingsStripped: false, environmentsUpdated: 0,
    pluginArchived: false,
  };
  await migrateRegistry(opts, report);
  await moveDirectories(opts, report);
  await compactLegacyJournal(opts, report);
  // A sealed config is left as it is; state above still moves.
  if (process.env.CORTEX_CONFIG_IMMUTABLE !== '1') {
    await stripSetting(opts.dataDir, report);
    await swapEnvironmentPlugins(opts.dataDir, report);
    await archivePlugin(opts, report);
  }
  return report;
}
