// History of subscription quota windows. The usage store keeps only an account's latest reading;
// this keeps one record per window period — (provider, account, window type, reset time) — with the
// highest utilization seen and when it was first and last seen, for 90 days. Recording is
// best-effort: it batches writes and never lets a failure reach usage polling.
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '@core/atomic-write.js';
import { registerFlushable } from '@core/json-repository.js';
import { createLogger } from '@core/log.js';
import { STORE_DIR } from '@core/paths.js';
import type { ProviderUsage } from './usage-store.js';

const log = createLogger('usage-window-history');

const HISTORY_VERSION = 1;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Readings of one period can report reset times a little apart; periods are hours apart. */
const RESET_JITTER_MS = 5 * 60 * 1000;
const WRITE_DELAY_MS = 30_000;
const RECORDED_TYPE = /^(five_hour|seven_day.*|codex_.+)$/;

export interface UsageWindowRecord {
  provider: string;
  /** The account's connection id; null for the provider's default login. */
  route: string | null;
  windowType: string;
  /** The provider's own label for the window (e.g. a model-scoped weekly limit). */
  label?: string;
  /** Epoch ms, as last reported. */
  resetsAt: number;
  /** 0–1. */
  peakUtilization: number;
  firstObservedAt: number;
  lastObservedAt: number;
  /** Longest time-to-reset seen, ms: a lower bound on the window's length. */
  horizonMs: number;
}

export interface UsageWindowObservation {
  provider: string;
  route: string | null;
  windowType: string;
  label?: string;
  utilization: number;
  resetsAt: number;
  observedAt: number;
}

function rowObservations(row: ProviderUsage): UsageWindowObservation[] {
  if (row.billing !== 'subscription' || row.observedAt === null) return [];
  const observedAt = row.observedAt * 1000;
  return row.windows
    .filter((window) => window.utilization !== null && window.resetsAt !== null && RECORDED_TYPE.test(window.type))
    .map((window) => ({
      provider: row.provider, route: row.route ?? null, windowType: window.type,
      ...(window.label ? { label: window.label } : {}),
      utilization: window.utilization!, resetsAt: window.resetsAt! * 1000, observedAt,
    }));
}

/** The quota readings in usage rows: subscription rows with an observation time, windows with both
 *  a utilization and a reset time. Times convert from the rows' epoch seconds to ms. */
export function windowObservations(rows: readonly ProviderUsage[]): UsageWindowObservation[] {
  return rows.flatMap(rowObservations);
}

function samePeriod(record: UsageWindowRecord, observation: UsageWindowObservation): boolean {
  return record.provider === observation.provider && record.route === observation.route
    && record.windowType === observation.windowType
    && Math.abs(record.resetsAt - observation.resetsAt) <= RESET_JITTER_MS;
}

function newRecord(observation: UsageWindowObservation): UsageWindowRecord {
  return {
    provider: observation.provider, route: observation.route, windowType: observation.windowType,
    ...(observation.label ? { label: observation.label } : {}),
    resetsAt: observation.resetsAt, peakUtilization: observation.utilization,
    firstObservedAt: observation.observedAt, lastObservedAt: observation.observedAt,
    horizonMs: Math.max(0, observation.resetsAt - observation.observedAt),
  };
}

/** Fold one observation into its period's record (or a new one). Returns whether anything changed. */
export function mergeObservation(records: UsageWindowRecord[], observation: UsageWindowObservation): boolean {
  const record = records.find((candidate) => samePeriod(candidate, observation));
  if (!record) {
    records.push(newRecord(observation));
    return true;
  }
  const merged = { ...record };
  if (observation.observedAt >= record.lastObservedAt) {
    merged.lastObservedAt = observation.observedAt;
    merged.resetsAt = observation.resetsAt;
  }
  merged.firstObservedAt = Math.min(record.firstObservedAt, observation.observedAt);
  merged.peakUtilization = Math.max(record.peakUtilization, observation.utilization);
  merged.horizonMs = Math.max(record.horizonMs, observation.resetsAt - observation.observedAt);
  const changed = (Object.keys(merged) as Array<keyof UsageWindowRecord>).some((key) => merged[key] !== record[key]);
  Object.assign(record, merged);
  return changed;
}

/** Records whose period ended within the retention. */
export function pruneRecords(records: readonly UsageWindowRecord[], now: number): UsageWindowRecord[] {
  return records.filter((record) => record.resetsAt >= now - RETENTION_MS);
}

async function readRecords(filePath: string): Promise<UsageWindowRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { version?: unknown; records?: unknown };
    return parsed.version === HISTORY_VERSION && Array.isArray(parsed.records) ? parsed.records as UsageWindowRecord[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`usage window history unreadable, starting over: ${String(error)}`);
    return [];
  }
}

export interface UsageWindowHistoryOptions {
  filePath: string;
  now?: () => number;
  writeDelayMs?: number;
}

export class UsageWindowHistory {
  private records: UsageWindowRecord[] | null = null;
  private loading: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private readonly now: () => number;

  constructor(private readonly opts: UsageWindowHistoryOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Record the windows the rows report. Never throws; the write follows within half a minute. */
  observe(rows: readonly ProviderUsage[]): void {
    let observations: UsageWindowObservation[];
    try {
      observations = windowObservations(rows);
    } catch (error) {
      log.warn(`usage window observation skipped: ${String(error)}`);
      return;
    }
    if (observations.length === 0) return;
    this.chain = this.chain
      .then(async () => this.apply(observations))
      .catch((error: unknown) => log.warn(`usage window history update failed: ${String(error)}`));
  }

  async list(): Promise<UsageWindowRecord[]> {
    await this.chain;
    return pruneRecords(await this.load(), this.now()).map((record) => ({ ...record }));
  }

  /** Write any batched change now. */
  async flush(): Promise<void> {
    await this.chain;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.persist();
  }

  private async load(): Promise<UsageWindowRecord[]> {
    this.loading ??= readRecords(this.opts.filePath).then((records) => { this.records = records; });
    await this.loading;
    return this.records!;
  }

  private async apply(observations: UsageWindowObservation[]): Promise<void> {
    const records = await this.load();
    let changed = false;
    for (const observation of observations) {
      if (mergeObservation(records, observation)) changed = true;
    }
    if (!changed) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.chain = this.chain.then(() => this.persist());
    }, this.opts.writeDelayMs ?? WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  private async persist(): Promise<void> {
    if (!this.dirty || !this.records) return;
    this.dirty = false;
    this.records = pruneRecords(this.records, this.now());
    try {
      await fs.mkdir(path.dirname(this.opts.filePath), { recursive: true });
      await atomicWrite(this.opts.filePath, JSON.stringify({ version: HISTORY_VERSION, records: this.records }));
    } catch (error) {
      log.warn(`usage window history write failed: ${String(error)}`);
    }
  }
}

export const USAGE_WINDOW_HISTORY_FILE = path.join(STORE_DIR, 'usage-windows.json');

export const usageWindowHistory = new UsageWindowHistory({ filePath: USAGE_WINDOW_HISTORY_FILE });
registerFlushable(usageWindowHistory);
