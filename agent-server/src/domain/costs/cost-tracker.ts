// input:  costs.json, budget.json, env overrides
// output: recordCost / checkBudget / formatCostReport / ...
// pos:    budget check and cost record aggregation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { costRepo } from '@store/cost-repo.js';
import { projectStore } from '@domain/projects/index.js';
export type { CostsData, BudgetConfig } from '@store/cost-repo.js';

// ── Dynamic project name discovery (from context/projects/) ──

let _projectNames: string[] | null = null;

function loadProjectNames(): string[] {
  return projectStore.list().map(p => p.id);
}

function getProjectNames(): string[] {
  if (_projectNames === null) {
    _projectNames = loadProjectNames();
  }
  return _projectNames;
}

export interface CostEntry {
  timestamp: string;
  project: string;
  trigger: string;
  cost_usd: number;
  num_turns: number | null;
  duration_s: number | null;
  backend: string;
  mode: string;
  source: string;
  input_tokens?: number;
  output_tokens?: number;
  provider?: string;  // PI provider name; absent for Claude
  model?: string;     // PI model id; absent for Claude
}

interface PeriodBucket {
  today: number;
  week: number;
  month: number;
  total: number;
}

interface ModeBuckets {
  total: number;
  api: number;
  plan: number;
  [key: string]: number;
}

interface TokenBucket {
  input: number;
  output: number;
}

/** One calendar day in the 14-day cost series (local day). date = `YYYY-MM-DD`. */
export interface DailyCostPoint {
  date: string;
  cost: number;
}

export interface CostSummary {
  today: number;
  week: number;
  month: number;
  total: number;
  byMode: Record<string, ModeBuckets>;
  byProject: Record<string, PeriodBucket>;
  byTrigger: Record<string, PeriodBucket>;
  bySource: Record<string, PeriodBucket>;
  byBackend: Record<string, PeriodBucket>;
  tokens: { today: TokenBucket; month: TokenBucket; total: TokenBucket };
  entryCount: number;
  // ── Additive real-data fields (task c489; ignored by Slack/TUI/MCP consumers) ──
  /** Daily budget denominator from budget.json `daily_usd` (global, not per-project). */
  dailyBudget: number;
  /** Today's scoped spend extrapolated linearly by the elapsed fraction of the local day.
   *  0 when nothing was spent today; noisy early in the day (small fraction) by construction. */
  forecastToday: number;
  /** Per-calendar-day scoped cost for the last 14 local days, oldest→newest, last = today.
   *  Zero-filled for days with no entries; respects the `project` filter. */
  dailyCost: DailyCostPoint[];
  /** Project-scoped "where it goes" trigger breakdown (byTrigger with the project filter applied).
   *  Categories with no scoped entries are simply absent (no fabricated placeholders). */
  byTriggerScoped: Record<string, PeriodBucket>;
}

export interface BudgetStatus {
  withinBudget: boolean;
  dailyBudget: number;
  dailySpent: number;
  dailyRemaining: number;
  monthlyBudget: number;
  monthlySpent: number;
  monthlyRemaining: number;
  byMode: Record<string, ModeBuckets>;
}

const COST_CATEGORIES = ['total', 'api', 'plan'];

function normalizeCostMode(mode: string | undefined): string {
  return mode === 'plan' ? 'plan' : 'api';
}

function createBucket(): PeriodBucket {
  return { today: 0, week: 0, month: 0, total: 0 };
}

function createPeriodBuckets(): ModeBuckets {
  return Object.fromEntries(COST_CATEGORIES.map(category => [category, 0])) as ModeBuckets;
}

function addCostByMode(target: ModeBuckets, mode: string, cost: number): void {
  target.total += cost;
  target[mode] += cost;
}

/**
 * Record a cost entry after a Claude invocation.
 * source: 'estimate' (default, from Claude CLI) or 'gateway' (from aistatus gateway usage data)
 * Gateway entries may have cost_usd=0 (e.g. plan mode) but still track tokens.
 */
async function recordCost({ project, trigger, cost_usd, num_turns, duration_s, backend, mode, source, input_tokens, output_tokens, provider, model }: {
  project?: string; trigger?: string; cost_usd?: number | null; num_turns?: number | null;
  duration_s?: number | null; backend?: string; mode?: string; source?: string;
  input_tokens?: number; output_tokens?: number; provider?: string; model?: string;
}): Promise<void> {
  const effectiveSource = source || 'estimate';
  // Allow gateway entries with cost=0 (plan mode tracks tokens only)
  if (effectiveSource === 'estimate' && (cost_usd == null || cost_usd === 0)) return;

  const entry: CostEntry = {
    timestamp: new Date().toISOString(),
    project: project || 'general',
    trigger: trigger || 'unknown',
    cost_usd: cost_usd || 0,
    num_turns: num_turns || null,
    duration_s: duration_s || null,
    backend: backend || 'claude',
    mode: normalizeCostMode(mode),
    source: effectiveSource,
  };
  if (input_tokens != null) entry.input_tokens = input_tokens;
  if (output_tokens != null) entry.output_tokens = output_tokens;
  if (provider) entry.provider = provider;
  if (model) entry.model = model;

  await costRepo.recordEntry(entry);
}

/**
 * Detect project from a message string.
 *
 * @deprecated Use projectStore.resolveFromMessage() instead.
 *
 * Priority:
 *   1. [project:xxx] explicit tag — always wins
 *   2. Case-insensitive substring match against context/projects/ directory names
 *      (longest match wins when multiple project names appear in the message)
 *   3. 'general' fallback
 */
function detectProject(message: string | null | undefined): string {
  if (!message) return 'general';

  // 1. Explicit [project:xxx] tag
  const tagMatch = message.match(/\[project:([^\]]+)\]/);
  if (tagMatch) return tagMatch[1];

  // 2. Dynamic project name matching
  const projects = getProjectNames();
  const lower = message.toLowerCase();

  let bestMatch: string | null = null;
  let bestLen = 0;
  for (const project of projects) {
    const lowerProject = project.toLowerCase();
    if (lower.includes(lowerProject) && project.length > bestLen) {
      bestMatch = project;
      bestLen = project.length;
    }
  }

  // 3. Fallback
  return bestMatch || 'general';
}

function createTokenBucket(): TokenBucket {
  return { input: 0, output: 0 };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_SERIES_DAYS = 14;

/** Local calendar day key `YYYY-MM-DD` for a Date. */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addToBucket(bucket: PeriodBucket, cost: number, isToday: boolean, isWeek: boolean, isMonth: boolean): void {
  bucket.total += cost;
  if (isToday) bucket.today += cost;
  if (isWeek) bucket.week += cost;
  if (isMonth) bucket.month += cost;
}

/**
 * Get cost summary (global, optionally filtered by project).
 * `opts.now` overrides the clock (default Date.now()) — used for deterministic tests of the
 * time-relative fields (forecastToday / the 14-day dailyCost series).
 */
async function getCostSummary(project?: string | null, opts?: { now?: number }): Promise<CostSummary> {
  const data = await costRepo.readCosts();
  const budget = await costRepo.readBudget();
  const now = opts?.now ?? Date.now();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now - 7 * DAY_MS);
  const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  // 14-day series: pre-seed the last 14 local days (oldest→newest, last = today), zero-filled.
  const dailyKeys: string[] = [];
  for (let i = DAILY_SERIES_DAYS - 1; i >= 0; i--) {
    const d = new Date(dayStart); d.setDate(d.getDate() - i);
    dailyKeys.push(localDayKey(d));
  }
  const dailyMap = new Map<string, number>(dailyKeys.map(k => [k, 0]));

  const periods = {
    today: createPeriodBuckets(),
    week: createPeriodBuckets(),
    month: createPeriodBuckets(),
    total: createPeriodBuckets(),
  };
  const byProject: Record<string, PeriodBucket> = {};
  const byTrigger: Record<string, PeriodBucket> = {};
  const byTriggerScoped: Record<string, PeriodBucket> = {};
  const bySource: Record<string, PeriodBucket> = {};
  const byBackend: Record<string, PeriodBucket> = {};
  const tokens = { today: createTokenBucket(), month: createTokenBucket(), total: createTokenBucket() };
  let matchCount = 0;

  for (const rawEntry of data.entries) {
    const mode = normalizeCostMode(rawEntry.mode);
    const cost = rawEntry.cost_usd || 0;
    const entrySource = rawEntry.source || 'estimate';
    const entryBackend = rawEntry.backend || 'claude';
    const entryTime = new Date(rawEntry.timestamp);
    const isToday = entryTime >= dayStart;
    const isWeek = entryTime >= weekStart;
    const isMonth = entryTime >= monthStart;
    const matchesProject = !project || rawEntry.project === project;

    // Scoped periods (filtered by project if specified)
    if (matchesProject) {
      matchCount++;
      addCostByMode(periods.total, mode, cost);
      if (isToday) addCostByMode(periods.today, mode, cost);
      if (isWeek) addCostByMode(periods.week, mode, cost);
      if (isMonth) addCostByMode(periods.month, mode, cost);

      // Token aggregation (scoped)
      const inTok = rawEntry.input_tokens || 0;
      const outTok = rawEntry.output_tokens || 0;
      tokens.total.input += inTok;
      tokens.total.output += outTok;
      if (isToday) { tokens.today.input += inTok; tokens.today.output += outTok; }
      if (isMonth) { tokens.month.input += inTok; tokens.month.output += outTok; }

      // Scoped 14-day series (only days inside the window contribute).
      const dayKey = localDayKey(entryTime);
      if (dailyMap.has(dayKey)) dailyMap.set(dayKey, dailyMap.get(dayKey)! + cost);

      // Scoped where-it-goes trigger breakdown.
      if (!byTriggerScoped[rawEntry.trigger]) byTriggerScoped[rawEntry.trigger] = createBucket();
      addToBucket(byTriggerScoped[rawEntry.trigger], cost, isToday, isWeek, isMonth);
    }

    // Global breakdowns (always all entries)
    if (!byProject[rawEntry.project]) byProject[rawEntry.project] = createBucket();
    if (!byTrigger[rawEntry.trigger]) byTrigger[rawEntry.trigger] = createBucket();
    if (!bySource[entrySource]) bySource[entrySource] = createBucket();
    if (!byBackend[entryBackend]) byBackend[entryBackend] = createBucket();
    addToBucket(byProject[rawEntry.project], cost, isToday, isWeek, isMonth);
    addToBucket(byTrigger[rawEntry.trigger], cost, isToday, isWeek, isMonth);
    addToBucket(bySource[entrySource], cost, isToday, isWeek, isMonth);
    addToBucket(byBackend[entryBackend], cost, isToday, isWeek, isMonth);
  }

  const todayScoped = periods.today.total;
  const fractionElapsed = (now - dayStart.getTime()) / DAY_MS;
  const forecastToday = fractionElapsed > 0 ? todayScoped / fractionElapsed : todayScoped;

  return {
    today: periods.today.total,
    week: periods.week.total,
    month: periods.month.total,
    total: periods.total.total,
    byMode: periods,
    byProject,
    byTrigger,
    bySource,
    byBackend,
    tokens,
    entryCount: matchCount,
    dailyBudget: budget.daily_usd,
    forecastToday,
    dailyCost: dailyKeys.map(date => ({ date, cost: dailyMap.get(date)! })),
    byTriggerScoped,
  };
}

/**
 * Check global budget (not per-project).
 * Returns budget status and whether we're within limits.
 */
async function checkBudget(): Promise<BudgetStatus> {
  const summary = await getCostSummary();
  const budget = await costRepo.readBudget();

  return {
    withinBudget: summary.today < budget.daily_usd && summary.month < budget.monthly_usd,
    dailyBudget: budget.daily_usd,
    dailySpent: summary.today,
    dailyRemaining: Math.max(0, budget.daily_usd - summary.today),
    monthlyBudget: budget.monthly_usd,
    monthlySpent: summary.month,
    monthlyRemaining: Math.max(0, budget.monthly_usd - summary.month),
    byMode: summary.byMode,
  };
}

/**
 * Update global budget limits.
 */
async function setBudget({ daily_usd, monthly_usd }: { daily_usd?: number; monthly_usd?: number }): Promise<{ daily_usd: number; monthly_usd: number }> {
  const budget = await costRepo.readBudget();
  if (daily_usd != null) budget.daily_usd = daily_usd;
  if (monthly_usd != null) budget.monthly_usd = monthly_usd;
  await costRepo.writeBudget(budget);
  return budget;
}

function buildModeBucket(periods: Record<string, ModeBuckets>, mode: string): PeriodBucket {
  return {
    today: periods.today[mode],
    week: periods.week[mode],
    month: periods.month[mode],
    total: periods.total[mode],
  };
}

function formatModeLine(label: string, bucket: PeriodBucket): string {
  return `  - ${label}: today $${bucket.today.toFixed(2)} | week $${bucket.week.toFixed(2)} | month $${bucket.month.toFixed(2)} | total $${bucket.total.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/**
 * Format cost summary as a readable string for Slack.
 */
async function formatCostReport(project: string | null = null): Promise<string> {
  const summary = await getCostSummary(project);
  const budget = await checkBudget();

  const lines = [];
  lines.push(project ? `*Cost Report (project: ${project})*` : '*Cost Report*');
  lines.push(`• Today: $${summary.today.toFixed(2)} / $${budget.dailyBudget} (remaining: $${budget.dailyRemaining.toFixed(2)})`);
  lines.push(`• This month: $${summary.month.toFixed(2)} / $${budget.monthlyBudget} (remaining: $${budget.monthlyRemaining.toFixed(2)})`);
  lines.push(`• This week: $${summary.week.toFixed(2)}`);
  lines.push(`• Total (90d): $${summary.total.toFixed(2)}`);
  lines.push('');
  lines.push('_By cost mode:_');
  lines.push(formatModeLine('API', buildModeBucket(summary.byMode, 'api')));
  lines.push(formatModeLine('Plan', buildModeBucket(summary.byMode, 'plan')));

  // Source breakdown (gateway vs estimate)
  if (Object.keys(summary.bySource).length > 0) {
    lines.push('');
    lines.push('_By source:_');
    for (const [src, stats] of Object.entries(summary.bySource).sort((a, b) => b[1].total - a[1].total)) {
      lines.push(`• ${src}: today $${stats.today.toFixed(2)} | month $${stats.month.toFixed(2)} | total $${stats.total.toFixed(2)}`);
    }
  }

  // Backend breakdown — show when PI is present (N2H-2: simplified condition)
  if ('pi' in summary.byBackend) {
    lines.push('');
    lines.push('_By backend:_');
    for (const [backend, stats] of Object.entries(summary.byBackend).sort((a, b) => b[1].total - a[1].total)) {
      lines.push(`• ${backend}: today $${stats.today.toFixed(2)} | month $${stats.month.toFixed(2)} | total $${stats.total.toFixed(2)}`);
    }
  }

  // Token usage (from gateway data)
  const tok = summary.tokens;
  if (tok.total.input > 0 || tok.total.output > 0) {
    lines.push('');
    lines.push('_Token usage:_');
    lines.push(`• Today: ${formatTokens(tok.today.input)} in / ${formatTokens(tok.today.output)} out`);
    lines.push(`• Month: ${formatTokens(tok.month.input)} in / ${formatTokens(tok.month.output)} out`);
    lines.push(`• Total: ${formatTokens(tok.total.input)} in / ${formatTokens(tok.total.output)} out`);
  }

  if (!project && Object.keys(summary.byProject).length > 0) {
    lines.push('');
    lines.push('_By project:_');
    for (const [proj, stats] of Object.entries(summary.byProject).sort((a, b) => b[1].month - a[1].month)) {
      lines.push(`• ${proj}: today $${stats.today.toFixed(2)} | month $${stats.month.toFixed(2)}`);
    }
  }

  if (Object.keys(summary.byTrigger).length > 0) {
    lines.push('');
    lines.push('_By trigger:_');
    for (const [trigger, stats] of Object.entries(summary.byTrigger).sort((a, b) => b[1].total - a[1].total)) {
      lines.push(`• ${trigger}: today $${stats.today.toFixed(2)} | month $${stats.month.toFixed(2)} | total $${stats.total.toFixed(2)}`);
    }
  }

  return lines.join('\n');
}

/** Reset the project name cache. Pass an array to pre-seed the cache (for tests). */
function _resetProjectCache(names?: string[] | null): void {
  _projectNames = names ?? null;
}

export { costRepo, recordCost, detectProject, getCostSummary, checkBudget, setBudget, formatCostReport, _resetProjectCache };
