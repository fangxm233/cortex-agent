// input:  costs.jsonl + budget.json
// output: CostRepo (recordEntry / recordEntryBatch / readCosts / readBudget / writeBudget /
//         invalidateBudget / flush) + migrateBudget
// pos:    Cost + Budget persistence layer. Costs use JSONL + append-only (avoiding repeated full-file reads/writes),
//         Budget still uses the JsonRepository abstraction. Budget carries global limits plus an
//         optional per-project override map (pair-only overrides).
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import fs from 'node:fs/promises';
import { JsonRepository } from '@core/json-repository.js';
import { atomicWrite } from '@core/atomic-write.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { STORE_DIR, CONFIG_DIR } from '@core/paths.js';
import type { CostEntry } from '@domain/costs/cost-tracker.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface CostsData {
  entries: CostEntry[];
}

/** A per-project override. Pair-only by design: a project either overrides BOTH limits or
 *  inherits BOTH globals — no per-field inheritance (see plan/per-project-budget.md). */
export interface ProjectBudget {
  daily_usd: number;
  monthly_usd: number;
}

export interface BudgetConfig {
  daily_usd: number;
  monthly_usd: number;
  /** Per-project overrides keyed by project id. Empty when no project overrides the globals. */
  projects: Record<string, ProjectBudget>;
}

const DEFAULT_BUDGET: BudgetConfig = { daily_usd: 300, monthly_usd: 8000, projects: {} };

function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Normalise the `projects` map from disk. Entries that are not a complete, positive
 * {daily_usd, monthly_usd} pair are dropped rather than partially trusted — a half-written
 * override would otherwise silently resolve against a field that does not exist.
 */
function normalizeProjects(raw: unknown): Record<string, ProjectBudget> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ProjectBudget> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !value || typeof value !== 'object') continue;
    const { daily_usd, monthly_usd } = value as Partial<ProjectBudget>;
    if (!isPositiveNumber(daily_usd) || !isPositiveNumber(monthly_usd)) continue;
    out[id] = { daily_usd, monthly_usd };
  }
  return out;
}

/** Fill missing/invalid top-level fields from defaults and normalise the per-project map. */
export function migrateBudget(raw: unknown): BudgetConfig {
  const partial = (raw && typeof raw === 'object' ? raw : {}) as Partial<BudgetConfig>;
  return {
    daily_usd: isPositiveNumber(partial.daily_usd) ? partial.daily_usd : DEFAULT_BUDGET.daily_usd,
    monthly_usd: isPositiveNumber(partial.monthly_usd) ? partial.monthly_usd : DEFAULT_BUDGET.monthly_usd,
    projects: normalizeProjects(partial.projects),
  };
}

function resolveCostsPath(): string {
  return process.env.CORTEX_COSTS_FILE || path.join(STORE_DIR, 'costs.jsonl');
}

function resolveBudgetPath(): string {
  return process.env.CORTEX_BUDGET_FILE || path.join(CONFIG_DIR, 'budget.json');
}

export class CostRepo {
  private costMutex = new AsyncMutex();
  private _ready = false;
  private _budgetRepo: JsonRepository<BudgetConfig> | null = null;
  private readonly _costsPath: string | null;
  private readonly _budgetPath: string | null;

  /**
   * Explicit paths override env-var / DATA_DIR resolution. If omitted, paths are resolved
   * lazily on first I/O from CORTEX_COSTS_FILE / CORTEX_BUDGET_FILE or default locations.
   */
  constructor(opts: { costsPath?: string; budgetPath?: string } = {}) {
    this._costsPath = opts.costsPath ?? null;
    this._budgetPath = opts.budgetPath ?? null;
  }

  private get costFilePath(): string {
    return this._costsPath ?? resolveCostsPath();
  }

  private get budgetRepo(): JsonRepository<BudgetConfig> {
    if (!this._budgetRepo) {
      this._budgetRepo = new JsonRepository<BudgetConfig>({
        filePath: this._budgetPath ?? resolveBudgetPath(),
        defaultValue: () => ({ ...DEFAULT_BUDGET, projects: {} }),
        migrate: migrateBudget,
      });
    }
    return this._budgetRepo;
  }

  /**
   * One-time startup init: ensure dir exists, prune stale entries.
   * Called from both read and write paths.
   */
  private async _ensureReady(): Promise<void> {
    if (this._ready) return;
    const filePath = this.costFilePath;
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Prune entries older than 90 days at startup
    const entries = await this._readFileEntries(filePath);
    const cutoff = Date.now() - NINETY_DAYS_MS;
    const recent = entries.filter(e => new Date(e.timestamp).getTime() > cutoff);
    if (recent.length < entries.length) {
      const content = recent.map(e => JSON.stringify(e)).join('\n') + '\n';
      await atomicWrite(filePath, content);
    }
    // Set _ready only after all async I/O completes — prevents concurrent
    // _testReset() calls from seeing a half-initialized state.
    this._ready = true;
  }

  /** Read raw JSONL file — no side effects. */
  private async _readFileEntries(filePath: string): Promise<CostEntry[]> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.split('\n')
        .filter(l => l.trim() !== '')
        .map(l => JSON.parse(l) as CostEntry);
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Record a single cost entry. Append-only — no full-file read.
   */
  async recordEntry(entry: CostEntry): Promise<void> {
    await this.costMutex.run(async () => {
      await this._ensureReady();
      await fs.appendFile(this.costFilePath, JSON.stringify(entry) + '\n', 'utf8');
    });
  }

  /**
   * Record multiple cost entries atomically in a single append.
   */
  async recordEntryBatch(entries: CostEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    await this.costMutex.run(async () => {
      await this._ensureReady();
      await fs.appendFile(this.costFilePath, lines, 'utf8');
    });
  }

  /**
   * Read all cost entries. Parses JSONL format. Triggers startup prune on first call.
   */
  async readCosts(): Promise<CostsData> {
    await this._ensureReady();
    const entries = await this._readFileEntries(this.costFilePath);
    return { entries };
  }

  async readBudget(): Promise<BudgetConfig> {
    return this.budgetRepo.read();
  }

  async writeBudget(budget: BudgetConfig): Promise<void> {
    await this.budgetRepo.write(budget);
  }

  /**
   * Drop the cached budget so the next readBudget() re-reads from disk.
   * budget.json is also written out-of-band by the UI service (mutate/config.ts writes the file
   * directly to stay hermetic over its configDir argument); without this the in-process view
   * would stay stale until restart.
   */
  invalidateBudget(): void {
    this._budgetRepo?.invalidate();
  }

  /**
   * Wait for any in-flight cost append / prune to complete, then flush budget repo.
   * For graceful SIGTERM drain.
   */
  async flush(): Promise<void> {
    await this.costMutex.run(async () => { /* drain serialised work */ });
    if (this._budgetRepo) await this._budgetRepo.flush();
  }

  /**
   * Clear lazy state so the next I/O picks up current env-var values.
   * Only for tests that change CORTEX_COSTS_FILE / CORTEX_BUDGET_FILE after module import.
   */
  _testReset(): void {
    this._budgetRepo = null;
    this._ready = false;
  }
}

export const costRepo = new CostRepo();
