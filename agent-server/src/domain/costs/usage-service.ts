// input:  daemon usage adapters, settings, usage store, gateway HTTP, and throttle observer
// output: side-effect-free status, explicit provider collection, and live quota observation
// pos:    Public orchestration service for provider usage visibility
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { getAdapter as getDaemonAdapter } from '../../agent-adapter/index.js';
import { Capability } from '../../agent-adapter/capabilities.js';
import type { AgentAdapter, AgentUsageScope, Backend } from '../../agent-adapter/types.js';
import { getSettings as readSettings, type Settings } from '@core/settings.js';
import { createLogger } from '@core/log.js';
import { handleRateLimitEvent, type RateLimitSource } from './rate-limit-throttle.js';
import { GATEWAY_URL } from './gateway-manager.js';
import {
  usageStore,
  UsageUnavailableError,
  type ProviderUsage,
} from './usage-store.js';

const log = createLogger('usage-service');
const GATEWAY_USAGE_TIMEOUT_MS = 5_000;
type GatewayPeriod = 'today' | 'month';
type SpendProvider = 'deepseek' | 'qwen-ksu';

type UsageAdapter = Pick<AgentAdapter, 'capabilities' | 'getUsage'>;
type AdapterResolver = (backend: Backend) => UsageAdapter;
type SettingsReader = () => Pick<Settings, 'anthropicSubscriptionModes'>;
type ObserveRateLimit = (
  info: { rateLimitType: string; rateLimitLabel?: string; utilization: number; resetsAt: number },
  source: RateLimitSource,
) => Promise<void>;

export interface UsageServiceStore {
  list(): Promise<ProviderUsage[]>;
  get(provider: string): Promise<ProviderUsage | null>;
  update(record: ProviderUsage): Promise<void>;
}

export interface UsageServiceDependencies {
  store?: UsageServiceStore;
  getAdapter?: AdapterResolver;
  getSettings?: SettingsReader;
  fetch?: typeof globalThis.fetch;
  gatewayUrl?: string;
  observeRateLimit?: ObserveRateLimit;
}

interface AdapterSource {
  backend: Backend;
  provider: string;
  displayName: string;
  scope: AgentUsageScope;
  modes: string[];
  noObservationNote?: string;
}

interface GatewaySpend {
  deepseek: number;
  'qwen-ksu': number;
}

interface GatewayPeriodSpend {
  spend: GatewaySpend;
  errors: Partial<Record<SpendProvider, string>>;
}

const PI_SOURCE: AdapterSource = {
  backend: 'pi',
  provider: 'openai-codex',
  displayName: 'OpenAI Codex',
  scope: { provider: 'openai-codex', mode: 'openai-codex' },
  modes: ['openai-codex'],
};

const SPEND_PROVIDERS: Record<SpendProvider, { displayName: string; modes: string[] }> = {
  deepseek: { displayName: 'DeepSeek', modes: ['deepseek'] },
  'qwen-ksu': { displayName: 'Qwen KSU', modes: ['qwen-ksu'] },
};

function normalizeModes(modes: string[]): string[] {
  return [...new Set(modes.map((mode) => mode.trim()).filter(Boolean))];
}

function anthropicSource(modes: string[]): AdapterSource {
  return {
    backend: 'claude',
    provider: 'anthropic',
    displayName: 'Anthropic',
    scope: { provider: 'anthropic', mode: modes[0] },
    modes,
    noObservationNote: 'account usage source has no observation',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableRecord(
  source: AdapterSource,
  prior: ProviderUsage | null,
  note: string | undefined,
): ProviderUsage {
  const annotation = note === undefined ? {} : { note };
  if (!prior) {
    return {
      provider: source.provider,
      displayName: source.displayName,
      modes: source.modes,
      windows: [],
      observedAt: null,
      freshness: 'never',
      ...annotation,
    };
  }
  const { note: _priorNote, ...retained } = prior;
  return {
    ...retained,
    modes: source.modes,
    freshness: prior.observedAt === null ? 'never' : 'stale',
    ...annotation,
  };
}

function normalizeAdapterRecord(record: ProviderUsage, source: AdapterSource): ProviderUsage {
  return {
    ...record,
    provider: source.provider,
    displayName: source.displayName,
    modes: source.modes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalSpendProvider(provider: string): SpendProvider | null {
  if (provider === 'deepseek') return 'deepseek';
  if (provider === 'qwen' || provider === 'qwen-ksu') return 'qwen-ksu';
  return null;
}

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function parseGatewaySpend(payload: unknown): GatewayPeriodSpend {
  if (!isRecord(payload) || !Array.isArray(payload.providers)) {
    throw new Error('gateway usage response has no provider rows');
  }
  const result: GatewayPeriodSpend = {
    spend: { deepseek: 0, 'qwen-ksu': 0 },
    errors: {},
  };
  for (const row of payload.providers) addGatewayRow(result, row);
  return result;
}

function addGatewayRow(result: GatewayPeriodSpend, row: unknown): void {
  if (!isRecord(row) || typeof row.provider !== 'string') {
    throw new Error('gateway usage provider row is invalid');
  }
  const provider = canonicalSpendProvider(row.provider);
  if (!provider) return;
  if (typeof row.cost_usd !== 'number' || !Number.isFinite(row.cost_usd)) {
    result.errors[provider] = `gateway usage cost is invalid for ${row.provider}`;
    return;
  }
  result.spend[provider] = roundCost(result.spend[provider] + row.cost_usd);
}

function periodFailure(
  result: PromiseSettledResult<GatewayPeriodSpend>,
  provider: SpendProvider,
): string | null {
  if (result.status === 'rejected') return errorMessage(result.reason);
  return result.value.errors[provider] ?? null;
}

function periodAvailable(
  result: PromiseSettledResult<GatewayPeriodSpend>,
  provider: SpendProvider,
): boolean {
  return result.status === 'fulfilled' && result.value.errors[provider] === undefined;
}

function periodValue(
  result: PromiseSettledResult<GatewayPeriodSpend>,
  provider: SpendProvider,
  prior: number | undefined,
): number {
  if (!periodAvailable(result, provider)) return prior ?? 0;
  return result.status === 'fulfilled' ? result.value.spend[provider] : prior ?? 0;
}

function gatewayNote(
  provider: SpendProvider,
  today: PromiseSettledResult<GatewayPeriodSpend>,
  month: PromiseSettledResult<GatewayPeriodSpend>,
): string | undefined {
  const todayFailure = periodFailure(today, provider);
  const monthFailure = periodFailure(month, provider);
  const failures = [
    todayFailure ? `today: ${todayFailure}` : null,
    monthFailure ? `month: ${monthFailure}` : null,
  ].filter((message): message is string => message !== null);
  return failures.length > 0 ? `gateway usage collection failed (${failures.join('; ')})` : undefined;
}

function observableWindows(record: ProviderUsage) {
  return record.windows.filter((window) => window.utilization !== null && window.resetsAt !== null);
}

function observationSources(record: ProviderUsage): RateLimitSource[] {
  const modes = record.modes.length > 0 ? record.modes : [undefined];
  return modes.map((mode) => ({ provider: record.provider, displayName: record.displayName, ...(mode ? { mode } : {}) }));
}

async function observeProviderUsage(record: ProviderUsage, observe: ObserveRateLimit): Promise<void> {
  for (const source of observationSources(record)) {
    for (const window of observableWindows(record)) {
      await observe({
        rateLimitType: window.type,
        ...(window.label ? { rateLimitLabel: window.label } : {}),
        utilization: window.utilization!,
        resetsAt: window.resetsAt!,
      }, source);
    }
  }
}

export class UsageService {
  private readonly store: UsageServiceStore;
  private readonly getAdapter: AdapterResolver;
  private readonly getSettings: SettingsReader;
  private readonly fetch: typeof globalThis.fetch;
  private readonly gatewayUrl: string;
  private readonly observeRateLimit: ObserveRateLimit;

  constructor(dependencies: UsageServiceDependencies = {}) {
    this.store = dependencies.store ?? usageStore;
    this.getAdapter = dependencies.getAdapter ?? getDaemonAdapter;
    this.getSettings = dependencies.getSettings ?? readSettings;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.gatewayUrl = dependencies.gatewayUrl ?? GATEWAY_URL;
    this.observeRateLimit = dependencies.observeRateLimit ?? handleRateLimitEvent;
  }

  async getStatus(): Promise<ProviderUsage[]> {
    return this.store.list();
  }

  async collect(): Promise<ProviderUsage[]> {
    const modes = normalizeModes(this.getSettings().anthropicSubscriptionModes);
    const anthropicCollection = modes.length > 0
      ? this.collectAdapter(anthropicSource(modes))
      : this.disableAnthropicUsage();
    await Promise.all([
      this.collectAdapter(PI_SOURCE),
      this.collectGatewaySpend(),
      anthropicCollection,
    ]);
    return this.getStatus();
  }

  async refresh(): Promise<ProviderUsage[]> {
    return this.collect();
  }

  private async collectAdapter(source: AdapterSource): Promise<void> {
    const prior = await this.store.get(source.provider);
    try {
      const adapter = this.getAdapter(source.backend);
      const records = await this.readAdapter(adapter, source.scope);
      const observed = records?.find((record) => record.provider === source.provider);
      const next = observed
        ? normalizeAdapterRecord(observed, source)
        : unavailableRecord(source, prior, source.noObservationNote);
      await this.store.update(next);
      await this.observeLiveUsage(next);
    } catch (error) {
      const note = error instanceof UsageUnavailableError
        ? error.message
        : `${source.displayName} usage collection failed: ${errorMessage(error)}`;
      await this.store.update(unavailableRecord(source, prior, note));
    }
  }

  private async disableAnthropicUsage(): Promise<void> {
    const prior = await this.store.get('anthropic');
    if (!prior) return;
    await this.store.update({
      ...prior,
      modes: [],
      freshness: prior.observedAt === null ? 'never' : 'stale',
      note: 'Anthropic account usage collection disabled by settings',
    });
  }

  private async observeLiveUsage(record: ProviderUsage): Promise<void> {
    if (record.freshness !== 'live') return;
    try {
      await observeProviderUsage(record, this.observeRateLimit);
    } catch (error) {
      log.error(`Live usage observation failed for ${record.provider}: ${errorMessage(error)}`);
    }
  }

  private async readAdapter(
    adapter: UsageAdapter,
    scope: AgentUsageScope,
  ): Promise<ProviderUsage[] | null> {
    if (!adapter.capabilities.has(Capability.Usage) || !adapter.getUsage) return null;
    return adapter.getUsage(scope);
  }

  private async readGatewayPeriod(period: GatewayPeriod): Promise<GatewayPeriodSpend> {
    const url = `${this.gatewayUrl}/usage?period=${period}&group_by=provider`;
    const response = await this.fetch(url, { signal: AbortSignal.timeout(GATEWAY_USAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`gateway usage HTTP ${response.status}`);
    return parseGatewaySpend(await response.json());
  }

  private async collectGatewaySpend(): Promise<void> {
    const [today, month] = await Promise.allSettled([
      this.readGatewayPeriod('today'),
      this.readGatewayPeriod('month'),
    ]);
    await Promise.all((Object.keys(SPEND_PROVIDERS) as SpendProvider[])
      .map((provider) => this.updateSpendProvider(provider, today, month)));
  }

  private async updateSpendProvider(
    provider: SpendProvider,
    today: PromiseSettledResult<GatewayPeriodSpend>,
    month: PromiseSettledResult<GatewayPeriodSpend>,
  ): Promise<void> {
    const prior = await this.store.get(provider);
    const todayAvailable = periodAvailable(today, provider);
    const monthAvailable = periodAvailable(month, provider);
    const hasSpend = todayAvailable || monthAvailable || prior?.spend !== undefined;
    const definition = SPEND_PROVIDERS[provider];
    const note = gatewayNote(provider, today, month);
    await this.store.update({
      provider,
      displayName: definition.displayName,
      modes: definition.modes,
      windows: [],
      ...(hasSpend ? { spend: {
        today: periodValue(today, provider, prior?.spend?.today),
        month: periodValue(month, provider, prior?.spend?.month),
      } } : {}),
      observedAt: null,
      freshness: 'unsupported',
      ...(note ? { note } : {}),
    });
  }
}

export const usageService = new UsageService();
