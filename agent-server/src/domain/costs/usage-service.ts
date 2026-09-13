// input:  gateway usage/quota HTTP, PI adapter quota, settings, usage store
// output: one usage row per (provider, billing kind) — subscription quota or metered spend
// pos:    Public orchestration service for provider usage visibility
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { getAdapter as getDaemonAdapter, getEngineAdapter } from '../runs/adapters.js';
import { Capability } from '../../agent-adapter/capabilities.js';
import type { AgentUsageScope, Backend } from '../../agent-adapter/types.js';
import { getSettings as readSettings, type Settings } from '@core/settings.js';
import { GATEWAY_URL } from './gateway-manager.js';
import {
  usageStore,
  usageRecordKey,
  type ProviderUsage,
  type UsageBilling,
  type UsageWindow,
} from './usage-store.js';

const GATEWAY_USAGE_TIMEOUT_MS = 5_000;
/** Cap on raw records pulled per period when the gateway cannot group by billing mode. */
const GATEWAY_RECORDS_LIMIT = 20_000;
/**
 * Mirrors the gateway's own `period=month`, which is a rolling 30 days rather than a calendar
 * month. Keeping the two definitions identical is what lets the grouped and record-aggregated
 * routes report the same figure; drifting from it would make the month total jump when the
 * gateway gains composite grouping and collection switches routes.
 */
const MONTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type GatewayPeriod = 'today' | 'month';

/** The slice of a backend adapter the usage service reads: its capability set (the Codex
 *  subscription probe is capability-gated) and its usage pull, which only some backends have. */
type UsageAdapter = {
  readonly capabilities: Set<Capability>;
  getUsage?(scope: AgentUsageScope): Promise<ProviderUsage[] | null>;
};
type AdapterResolver = (backend: Backend) => UsageAdapter;

/** PI's usage probe lives on the engine adapter; the other backends keep it on the daemon adapter. */
function defaultUsageAdapter(backend: Backend): UsageAdapter {
  return backend === 'pi' ? getEngineAdapter('pi') : getDaemonAdapter(backend);
}
type SettingsReader = () => Pick<Settings, 'anthropicSubscriptionModes' | 'subscriptionBillingModes'>;

export interface UsageServiceStore {
  list(): Promise<ProviderUsage[]>;
  commit(records: ProviderUsage[]): Promise<void>;
}

export interface UsageServiceDependencies {
  store?: UsageServiceStore;
  getAdapter?: AdapterResolver;
  getSettings?: SettingsReader;
  fetch?: typeof globalThis.fetch;
  gatewayUrl?: string;
  now?: () => Date;
}

/**
 * One (provider, gateway billing mode) pair's cost within a period. A null cost means the
 * gateway named the pair but its figure was unusable, which must not be read as zero.
 */
interface SpendRow {
  provider: string;
  billingMode: string;
  cost: number | null;
}

interface PeriodSpend {
  rows: SpendRow[];
  truncated: boolean;
  /** Records the gateway returned whose cost could not be read; their spend is missing. */
  droppedRecords: number;
}

interface GatewayQuotaSnapshot {
  windows: UsageWindow[];
  observedAt: number;
}

const CODEX_SCOPE: AgentUsageScope = { provider: 'openai-codex', mode: 'openai-codex' };
const CODEX_PROVIDER = 'openai-codex';
const ANTHROPIC_PROVIDER = 'anthropic';

/**
 * Brand-name overrides for providers whose id does not title-case correctly.
 * This table never decides which rows exist — it only spells them.
 */
const KNOWN_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  'openai-codex': 'OpenAI Codex',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  zai: 'Z.ai',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax CN',
  huggingface: 'Hugging Face',
  githubCopilot: 'GitHub Copilot',
  'github-copilot': 'GitHub Copilot',
  'google-gemini-cli': 'Google Gemini CLI',
  'google-antigravity': 'Google Antigravity',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  'kimi-coding': 'Kimi Coding',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
};

function fallbackDisplayName(provider: string): string {
  const parts = provider.split(/[-_]/).filter(Boolean);
  if (parts.length === 0) return provider;
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function displayNameFor(provider: string): string {
  return KNOWN_DISPLAY_NAMES[provider] ?? fallbackDisplayName(provider);
}

function normalizeModes(modes: string[]): string[] {
  return [...new Set(modes.map((mode) => mode.trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ── Quota parsing (gateway /quota, Anthropic only) ─────────────

function quotaWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value) || (value.type !== 'five_hour' && value.type !== 'seven_day')) return null;
  const utilization = finiteNumber(value.utilization);
  if (utilization === null || utilization < 0 || utilization > 1) {
    throw new Error(`gateway quota utilization is invalid for ${String(value.type)}`);
  }
  const resetsAt = finiteNumber(value.resets_at);
  if (resetsAt === null || resetsAt < 0) {
    throw new Error(`gateway quota reset is invalid for ${String(value.type)}`);
  }
  return { type: value.type, utilization, resetsAt };
}

function parseGatewayQuota(payload: unknown): GatewayQuotaSnapshot | null {
  if (!isRecord(payload) || !Array.isArray(payload.providers)) {
    throw new Error('gateway quota response has no provider rows');
  }
  const provider = payload.providers.find((row) => isRecord(row) && row.provider === ANTHROPIC_PROVIDER);
  if (!provider) return null;
  if (!Array.isArray(provider.windows)) throw new Error('gateway quota windows are invalid');
  const observedAt = finiteNumber(provider.observed_at);
  if (observedAt === null || observedAt < 0) throw new Error('gateway quota observation time is invalid');
  const windows = provider.windows.flatMap((value) => {
    const window = quotaWindow(value);
    return window ? [window] : [];
  });
  return windows.length > 0 ? { windows, observedAt } : null;
}

// ── Spend parsing ──────────────────────────────────────────────

function spendRowKey(provider: string, billingMode: string): string {
  return `${provider}\u0000${billingMode}`;
}

/** An unusable figure poisons the pair's total: a partial sum must not pass as complete. */
function accumulateSpend(
  totals: Map<string, SpendRow>,
  provider: string,
  billingMode: string,
  cost: number | null,
): void {
  const key = spendRowKey(provider, billingMode);
  const existing = totals.get(key);
  if (!existing) {
    totals.set(key, { provider, billingMode, cost: cost === null ? null : roundCost(cost) });
    return;
  }
  if (cost === null || existing.cost === null) existing.cost = null;
  else existing.cost = roundCost(existing.cost + cost);
}

/**
 * The grouped route labels a record that carries no billing mode `unknown`, where the record
 * route simply sees the field missing. Collapsing the placeholder keeps both routes reporting
 * the same mode labels; either way an unnamed mode is absent from the subscription list and so
 * bills as metered.
 */
function unnamedMode(billingMode: string): string {
  return billingMode === 'unknown' ? '' : billingMode;
}

/**
 * Route A payload: rows carrying both `provider` and `billing_mode`. Returns null when the
 * gateway answered but without billing-mode granularity, so the caller can fall back.
 */
function parseGroupedSpend(payload: unknown): SpendRow[] | null {
  if (!isRecord(payload)) return null;
  const candidate = [payload.rows, payload.providers].find(Array.isArray);
  if (!candidate) return null;
  const totals = new Map<string, SpendRow>();
  for (const raw of candidate) {
    if (!isRecord(raw)) return null;
    const provider = typeof raw.provider === 'string' ? raw.provider : null;
    const billingMode = typeof raw.billing_mode === 'string' ? raw.billing_mode : null;
    if (provider === null || billingMode === null) return null;
    accumulateSpend(totals, provider, unnamedMode(billingMode), finiteNumber(raw.cost_usd));
  }
  return [...totals.values()];
}

/** Route B payload: raw usage records, aggregated client-side. */
function parseRecordSpend(payload: unknown): { rows: SpendRow[]; dropped: number } {
  if (!isRecord(payload) || !Array.isArray(payload.records)) {
    throw new Error('gateway usage records response has no record rows');
  }
  const totals = new Map<string, SpendRow>();
  let dropped = 0;
  for (const raw of payload.records) {
    if (!isRecord(raw) || typeof raw.provider !== 'string' || !raw.provider) {
      dropped += 1;
      continue;
    }
    const cost = finiteNumber(raw.cost);
    if (cost === null) {
      dropped += 1;
      continue;
    }
    accumulateSpend(totals, raw.provider, typeof raw.billing_mode === 'string' ? raw.billing_mode : '', cost);
  }
  return { rows: [...totals.values()], dropped };
}

function recordCount(payload: unknown): number {
  return isRecord(payload) && Array.isArray(payload.records) ? payload.records.length : 0;
}

function periodStartIso(period: GatewayPeriod, now: Date): string {
  if (period !== 'today') return new Date(now.getTime() - MONTH_WINDOW_MS).toISOString();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

// ── Row composition ────────────────────────────────────────────

interface RowDraft {
  provider: string;
  billing: UsageBilling;
  modes: Set<string>;
  spend: Record<GatewayPeriod, number | null>;
  /** Periods the gateway named this row in but could not price. */
  unpriced: Set<GatewayPeriod>;
  windows: UsageWindow[];
  observedAt: number | null;
  freshness: ProviderUsage['freshness'] | null;
  /** True once a quota source was actually consulted for this row. */
  quotaPolled: boolean;
  notes: string[];
}

function draftKey(provider: string, billing: UsageBilling): string {
  return usageRecordKey({ provider, billing });
}

function ensureDraft(drafts: Map<string, RowDraft>, provider: string, billing: UsageBilling): RowDraft {
  const key = draftKey(provider, billing);
  const existing = drafts.get(key);
  if (existing) return existing;
  const draft: RowDraft = {
    provider, billing, modes: new Set(), spend: { today: null, month: null },
    unpriced: new Set(), windows: [], observedAt: null, freshness: null,
    quotaPolled: false, notes: [],
  };
  drafts.set(key, draft);
  return draft;
}

function applySpendRows(
  drafts: Map<string, RowDraft>,
  rows: SpendRow[],
  subscriptionModes: Set<string>,
  period: GatewayPeriod,
): void {
  for (const row of rows) {
    const billing: UsageBilling = subscriptionModes.has(row.billingMode) ? 'subscription' : 'api';
    const draft = ensureDraft(drafts, row.provider, billing);
    if (row.billingMode) draft.modes.add(row.billingMode);
    // Subscription cost is an imputed API-equivalent price, not a bill — never surfaced.
    if (billing === 'subscription') continue;
    if (row.cost === null) {
      draft.unpriced.add(period);
      continue;
    }
    draft.spend[period] = roundCost((draft.spend[period] ?? 0) + row.cost);
  }
}

/** Resolve an unpriced period to the last stored figure rather than reporting a false zero. */
function settleSpend(draft: RowDraft, prior: ProviderUsage | undefined): void {
  for (const period of draft.unpriced) {
    const carried = prior?.spend?.[period];
    draft.spend[period] = carried ?? null;
    draft.notes.push(
      carried === undefined
        ? `gateway ${period} cost was unreadable`
        : `gateway ${period} cost was unreadable; showing the last known figure`,
    );
  }
}

function finalizeDraft(draft: RowDraft, prior: ProviderUsage | undefined): ProviderUsage {
  settleSpend(draft, prior);
  const hasSpend = draft.billing === 'api'
    && (draft.spend.today !== null || draft.spend.month !== null);
  const freshness = draft.freshness
    ?? (draft.quotaPolled ? (draft.observedAt === null ? 'never' : 'stale') : 'unsupported');
  return {
    provider: draft.provider,
    displayName: displayNameFor(draft.provider),
    modes: [...draft.modes].sort(),
    windows: draft.windows,
    ...(hasSpend ? { spend: { today: draft.spend.today ?? 0, month: draft.spend.month ?? 0 } } : {}),
    observedAt: draft.observedAt,
    freshness,
    billing: draft.billing,
    ...(draft.notes.length > 0 ? { note: draft.notes.join('; ') } : {}),
  };
}

/** Anthropic model-scoped windows are internal detail; the panel shows the account windows only. */
function visibleUsage(record: ProviderUsage): ProviderUsage {
  if (record.provider !== ANTHROPIC_PROVIDER) return record;
  return {
    ...record,
    windows: record.windows.filter((window) => window.type !== 'model_scoped'),
    freshness: record.observedAt === null ? record.freshness : 'stale',
  };
}

function staleCopy(record: ProviderUsage, note: string): ProviderUsage {
  const { note: _priorNote, ...retained } = record;
  // 'unsupported' means the row has no quota concept at all, so ageing it to 'never'
  // would claim a reading was expected. Only quota-bearing rows go stale.
  const freshness = record.freshness === 'unsupported'
    ? 'unsupported'
    : record.observedAt === null ? 'never' : 'stale';
  return { ...retained, freshness, note };
}

export class UsageService {
  private readonly store: UsageServiceStore;
  private readonly getAdapter: AdapterResolver;
  private readonly getSettings: SettingsReader;
  private readonly fetch: typeof globalThis.fetch;
  private readonly gatewayUrl: string;
  private readonly now: () => Date;
  /** Sticky once the gateway proves it cannot group by billing mode, to avoid a 400 per cycle. */
  private groupedSpendSupported = true;

  constructor(dependencies: UsageServiceDependencies = {}) {
    this.store = dependencies.store ?? usageStore;
    this.getAdapter = dependencies.getAdapter ?? defaultUsageAdapter;
    this.getSettings = dependencies.getSettings ?? readSettings;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.gatewayUrl = dependencies.gatewayUrl ?? GATEWAY_URL;
    this.now = dependencies.now ?? (() => new Date());
  }

  async getStatus(): Promise<ProviderUsage[]> {
    return (await this.store.list()).map(visibleUsage);
  }

  async collect(): Promise<ProviderUsage[]> {
    const settings = this.getSettings();
    const anthropicModes = normalizeModes(settings.anthropicSubscriptionModes);
    const subscriptionModes = new Set(normalizeModes(settings.subscriptionBillingModes));
    const prior = await this.store.list();

    const [today, month, quota, codex] = await Promise.allSettled([
      this.readSpend('today'),
      this.readSpend('month'),
      anthropicModes.length > 0 ? this.readGatewayQuota() : Promise.resolve(null),
      this.readCodexQuota(),
    ]);

    const drafts = new Map<string, RowDraft>();
    this.applyPeriod(drafts, today, subscriptionModes, 'today');
    this.applyPeriod(drafts, month, subscriptionModes, 'month');
    this.applyAnthropicQuota(drafts, quota, anthropicModes, prior);
    this.applyCodexQuota(drafts, codex, prior);

    const priorByKey = new Map(prior.map((record) => [usageRecordKey(record), record]));
    const composed = [...drafts.values()].map((draft) => finalizeDraft(
      draft,
      priorByKey.get(draftKey(draft.provider, draft.billing))
        ?? prior.find((row) => row.provider === draft.provider && row.billing === undefined),
    ));
    await this.store.commit(this.guardDeletions(composed, prior, today, month));
    return this.getStatus();
  }

  async refresh(): Promise<ProviderUsage[]> {
    return this.collect();
  }

  // ── Composition steps ────────────────────────────────────────

  private applyPeriod(
    drafts: Map<string, RowDraft>,
    result: PromiseSettledResult<PeriodSpend>,
    subscriptionModes: Set<string>,
    period: GatewayPeriod,
  ): void {
    if (result.status !== 'fulfilled') return;
    applySpendRows(drafts, result.value.rows, subscriptionModes, period);
    const warnings: string[] = [];
    if (result.value.truncated) {
      warnings.push(`gateway ${period} usage was truncated at ${GATEWAY_RECORDS_LIMIT} records; spend may be understated`);
    }
    if (result.value.droppedRecords > 0) {
      warnings.push(`gateway ${period} usage skipped ${result.value.droppedRecords} unreadable records; spend may be understated`);
    }
    if (warnings.length === 0) return;
    for (const draft of drafts.values()) {
      if (draft.billing === 'api') draft.notes.push(...warnings);
    }
  }

  private applyAnthropicQuota(
    drafts: Map<string, RowDraft>,
    result: PromiseSettledResult<GatewayQuotaSnapshot | null>,
    anthropicModes: string[],
    prior: ProviderUsage[],
  ): void {
    if (anthropicModes.length === 0) {
      const existing = drafts.get(draftKey(ANTHROPIC_PROVIDER, 'subscription'));
      if (existing) existing.notes.push('Anthropic account usage collection disabled by settings');
      return;
    }
    const draft = ensureDraft(drafts, ANTHROPIC_PROVIDER, 'subscription');
    draft.quotaPolled = true;
    for (const mode of anthropicModes) draft.modes.add(mode);
    if (result.status === 'fulfilled' && result.value) {
      draft.windows = result.value.windows;
      draft.observedAt = result.value.observedAt;
      draft.freshness = 'stale';
      return;
    }
    if (result.status === 'rejected') {
      draft.notes.push(`Anthropic gateway quota collection failed: ${errorMessage(result.reason)}`);
    } else {
      draft.notes.push('gateway has no Anthropic quota observation');
    }
    this.carryQuotaFromPrior(draft, prior);
  }

  private applyCodexQuota(
    drafts: Map<string, RowDraft>,
    result: PromiseSettledResult<ProviderUsage | null>,
    prior: ProviderUsage[],
  ): void {
    if (result.status === 'fulfilled' && result.value) {
      const draft = ensureDraft(drafts, CODEX_PROVIDER, 'subscription');
      draft.quotaPolled = true;
      draft.modes.add(CODEX_PROVIDER);
      draft.windows = result.value.windows;
      draft.observedAt = result.value.observedAt;
      draft.freshness = result.value.freshness;
      return;
    }
    // Observation-only: with no reading and no history, Codex is simply not in use here.
    const existing = drafts.get(draftKey(CODEX_PROVIDER, 'subscription'));
    const priorRow = prior.find((row) => row.provider === CODEX_PROVIDER);
    if (!existing && !priorRow) return;
    const draft = ensureDraft(drafts, CODEX_PROVIDER, 'subscription');
    draft.quotaPolled = true;
    draft.modes.add(CODEX_PROVIDER);
    if (result.status === 'rejected') {
      draft.notes.push(`OpenAI Codex usage collection failed: ${errorMessage(result.reason)}`);
    }
    this.carryQuotaFromPrior(draft, prior);
  }

  /** Keep the last good quota reading rather than blanking the row on a failed cycle. */
  private carryQuotaFromPrior(draft: RowDraft, prior: ProviderUsage[]): void {
    if (draft.windows.length > 0) return;
    const key = draftKey(draft.provider, draft.billing);
    const match = prior.find((row) => usageRecordKey(row) === key)
      ?? prior.find((row) => row.provider === draft.provider && row.billing === undefined);
    if (!match) return;
    draft.windows = match.windows.map((window) => ({ ...window }));
    draft.observedAt = match.observedAt;
    draft.freshness = match.observedAt === null ? 'never' : 'stale';
  }

  /**
   * Deleting a row is only safe when spend collection actually answered. If the gateway is
   * unreachable, fall back to "add but never remove" so a transient outage cannot wipe history.
   */
  private guardDeletions(
    composed: ProviderUsage[],
    prior: ProviderUsage[],
    today: PromiseSettledResult<PeriodSpend>,
    month: PromiseSettledResult<PeriodSpend>,
  ): ProviderUsage[] {
    if (today.status === 'fulfilled' && month.status === 'fulfilled') return composed;
    const note = today.status === 'rejected'
      ? `gateway usage collection failed: ${errorMessage(today.reason)}`
      : `gateway usage collection failed: ${errorMessage((month as PromiseRejectedResult).reason)}`;
    const seen = new Set(composed.map(usageRecordKey));
    const retained = prior
      .filter((row) => !seen.has(usageRecordKey(row)))
      .map((row) => staleCopy(row, note));
    return [...composed.map((row) => (row.note ? row : { ...row, note })), ...retained];
  }

  // ── Transport ────────────────────────────────────────────────

  private async readCodexQuota(): Promise<ProviderUsage | null> {
    const adapter = this.getAdapter('pi');
    if (!adapter.capabilities.has(Capability.Usage) || !adapter.getUsage) return null;
    const records = await adapter.getUsage(CODEX_SCOPE);
    return records?.find((record) => record.provider === CODEX_PROVIDER) ?? null;
  }

  private async readGatewayQuota(): Promise<GatewayQuotaSnapshot | null> {
    const url = `${this.gatewayUrl}/quota?provider=anthropic`;
    const response = await this.fetch(url, { signal: AbortSignal.timeout(GATEWAY_USAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`gateway quota HTTP ${response.status}`);
    return parseGatewayQuota(await response.json());
  }

  /** Route A (billing-mode grouping) when the gateway supports it, else Route B (raw records). */
  private async readSpend(period: GatewayPeriod): Promise<PeriodSpend> {
    if (this.groupedSpendSupported) {
      const grouped = await this.readGroupedSpend(period);
      if (grouped) return grouped;
      this.groupedSpendSupported = false;
    }
    return this.readRecordSpend(period);
  }

  private async readGroupedSpend(period: GatewayPeriod): Promise<PeriodSpend | null> {
    const url = `${this.gatewayUrl}/usage?period=${period}&group_by=provider,billing_mode`;
    const response = await this.fetch(url, { signal: AbortSignal.timeout(GATEWAY_USAGE_TIMEOUT_MS) });
    if (response.status === 400) return null;
    if (!response.ok) throw new Error(`gateway usage HTTP ${response.status}`);
    const rows = parseGroupedSpend(await response.json());
    return rows === null ? null : { rows, truncated: false, droppedRecords: 0 };
  }

  private async readRecordSpend(period: GatewayPeriod): Promise<PeriodSpend> {
    const since = encodeURIComponent(periodStartIso(period, this.now()));
    const url = `${this.gatewayUrl}/usage?format=records&since=${since}&limit=${GATEWAY_RECORDS_LIMIT}`;
    const response = await this.fetch(url, { signal: AbortSignal.timeout(GATEWAY_USAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`gateway usage HTTP ${response.status}`);
    const payload = await response.json();
    const { rows, dropped } = parseRecordSpend(payload);
    return { rows, truncated: recordCount(payload) >= GATEWAY_RECORDS_LIMIT, droppedRecords: dropped };
  }
}

export const usageService = new UsageService();
