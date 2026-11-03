import { getPiEngineAdapter } from '../runs/adapters.js';
import { Capability } from '../../agent-adapter/capabilities.js';
import type { AgentUsageScope } from '../../agent-adapter/types.js';
import { SUBSCRIPTION_CONNECTION, accountIdOf, type ClaudeAccountConnection } from '@core/connections-file.js';
import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import { costRepo } from '@store/cost-repo.js';
import { providerStateRepo } from '@store/provider-state-repo.js';
import { claudeAccountDir, credentialInventory } from '../connections/index.js';
import { claudeAccountClient, claudeAccountClientFor } from './claude-account.js';
import { codexAccountClient } from './codex-account.js';
import type { CostEntry } from './cost-tracker.js';
import { ledgerSpend, type AccountOf, type BillingOf, type LedgerSpendRow, type SpendFigures } from './ledger-spend.js';
import { releaseRecoveredQuota, type QuotaReading } from './rate-limit-throttle.js';
import type { AccountReading, ResetAccount } from './reset-account.js';
import {
  usageStore,
  usageRecordKey,
  type ProviderUsage,
  type UsageBilling,
  type UsageResetCredits,
  type UsageWindow,
} from './usage-store.js';

const log = createLogger('usage-service');

/** The slice of a backend adapter the usage service reads: its capability set (the Codex
 *  subscription probe is capability-gated) and its usage pull, which only some backends have. */
type UsageAdapter = {
  readonly capabilities: Set<Capability>;
  getUsage?(scope: AgentUsageScope): Promise<ProviderUsage[] | null>;
};
type AdapterResolver = () => UsageAdapter;

export interface UsageServiceStore {
  list(): Promise<ProviderUsage[]>;
  commit(records: ProviderUsage[]): Promise<void>;
}

/** One additional Claude account and the reader of its own usage. */
export interface ClaudeAccountReader {
  id: string;
  label: string;
  account: Pick<ResetAccount, 'readUsage'>;
}

/** When each provider's subscription — or one account of it, `provider::account` — was last signed
 *  out, epoch seconds. */
export interface SubscriptionSignOuts {
  list(): Promise<Record<string, number>>;
  /** Null clears the provider's entry. */
  set(provider: string, at: number | null): Promise<void>;
}

export interface UsageServiceDependencies {
  store?: UsageServiceStore;
  /** Absent, sign-outs last only as long as this service. */
  signOuts?: SubscriptionSignOuts;
  getAdapter?: AdapterResolver;
  /** The cost ledger's rows; spend is summed from them. */
  readLedger?: () => Promise<readonly CostEntry[]>;
  /** Whether a connection's spend is billed or covered by a subscription. */
  billingOf?: BillingOf;
  /** Which connections are accounts, so their spend and quota land on rows of their own. */
  accountOf?: AccountOf;
  now?: () => Date;
  /** Active Codex account reader; its readings replace the header-observed Codex row. Absent, only
   *  response headers inform the Codex row. */
  codexAccount?: Pick<ResetAccount, 'readUsage'>;
  /** Lifts throttle windows a fresh reading shows have recovered, on the route it was read for. */
  releaseThrottle?: (provider: string, windows: QuotaReading[], route?: string) => Promise<unknown>;
  /** Active Claude account reader, the source of the Anthropic subscription row's windows. Absent,
   *  the row keeps only what was last stored. */
  claudeAccount?: Pick<ResetAccount, 'readUsage'>;
  /** The additional Claude accounts; each is read like the default and gets a row of its own. */
  claudeAccounts?: () => ClaudeAccountReader[];
}

/** Which Anthropic login a quota read is for: the default, or one account. */
interface AnthropicTarget {
  route?: string;
  label?: string;
}

/** The Anthropic quota for one cycle: the account's reading when there is one. */
interface AnthropicQuotaResult {
  snapshot: QuotaSnapshot | null;
  resetCredits?: UsageResetCredits;
  /** The account read failed, so the reset credits last known still apply. */
  keepResets: boolean;
  notes: string[];
}

/** The Codex row for one cycle plus why it is not a fresh account reading, when it is not. */
interface CodexQuotaResult {
  record: ProviderUsage | null;
  note?: string;
}

interface QuotaSnapshot {
  windows: UsageWindow[];
  observedAt: number;
}

function memorySignOuts(): SubscriptionSignOuts {
  const entries = new Map<string, number>();
  return {
    list: async () => Object.fromEntries(entries),
    set: async (provider, at) => {
      if (at === null) entries.delete(provider);
      else entries.set(provider, at);
    },
  };
}

/** Without an injected account reader, Codex usage is only what response headers reported. */
const NO_ACCOUNT: Pick<ResetAccount, 'readUsage'> = { readUsage: async () => null };

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Row composition ────────────────────────────────────────────

interface RowDraft {
  provider: string;
  billing: UsageBilling;
  /** The account the row is for; absent on the default login. */
  route?: string;
  label?: string;
  /** Connections the row's traffic ran on. */
  modes: Set<string>;
  spend: SpendFigures | null;
  windows: UsageWindow[];
  observedAt: number | null;
  freshness: ProviderUsage['freshness'] | null;
  /** True once a quota source was actually consulted for this row. */
  quotaPolled: boolean;
  resetCredits?: UsageResetCredits;
  notes: string[];
}

function draftKey(provider: string, billing: UsageBilling, route?: string): string {
  return usageRecordKey({ provider, billing, route });
}

function ensureDraft(drafts: Map<string, RowDraft>, provider: string, billing: UsageBilling, route?: string): RowDraft {
  const key = draftKey(provider, billing, route);
  const existing = drafts.get(key);
  if (existing) return existing;
  const draft: RowDraft = {
    provider, billing, ...(route ? { route } : {}), modes: new Set(), spend: null, windows: [], observedAt: null,
    freshness: null, quotaPolled: false, notes: [],
  };
  drafts.set(key, draft);
  return draft;
}

/** Recent traffic is what makes a row: a provider idle for 30 days has none. */
function applyLedgerRows(drafts: Map<string, RowDraft>, rows: LedgerSpendRow[]): void {
  for (const row of rows) {
    const draft = ensureDraft(drafts, row.provider, row.billing, row.route);
    row.connections.forEach((connection) => draft.modes.add(connection));
    draft.spend = row.spend;
  }
}

function finalizeDraft(draft: RowDraft): ProviderUsage {
  const freshness = draft.freshness
    ?? (draft.quotaPolled ? (draft.observedAt === null ? 'never' : 'stale') : 'unsupported');
  const name = displayNameFor(draft.provider);
  return {
    provider: draft.provider,
    ...(draft.route ? { route: draft.route } : {}),
    ...(draft.route && draft.label ? { label: draft.label } : {}),
    displayName: draft.route ? `${name} (${draft.label ?? draft.route})` : name,
    modes: [...draft.modes].sort(),
    windows: draft.windows,
    // Subscription cost is an imputed API-equivalent price, not a bill — never surfaced.
    ...(draft.billing === 'api' && draft.spend ? { spend: { ...draft.spend } } : {}),
    observedAt: draft.observedAt,
    freshness,
    billing: draft.billing,
    ...(draft.resetCredits ? { resetCredits: draft.resetCredits } : {}),
    ...(draft.notes.length > 0 ? { note: draft.notes.join('; ') } : {}),
  };
}

/** The sign-out entry of a provider's default login, or of one account of it. */
function signOutKey(provider: string, route?: string | null): string {
  return route ? `${provider}::${route}` : provider;
}

/** A signed-out subscription stays hidden until a reading taken after the sign-out; metered rows
 *  are unaffected. */
function isSignedOut(record: ProviderUsage, signOuts: Record<string, number>): boolean {
  const at = signOuts[signOutKey(record.provider, record.route)];
  if (at === undefined || record.billing === 'api') return false;
  return record.observedAt === null || record.observedAt <= at;
}

/** Anthropic model-scoped windows are internal detail; the panel shows the account windows only. */
function visibleUsage(record: ProviderUsage): ProviderUsage {
  if (record.provider !== ANTHROPIC_PROVIDER) return record;
  return { ...record, windows: record.windows.filter((window) => window.type !== 'model_scoped') };
}

function liveCodexUsage(live: AccountReading, observedAt: number): ProviderUsage {
  return {
    provider: CODEX_PROVIDER,
    displayName: displayNameFor(CODEX_PROVIDER),
    modes: [CODEX_PROVIDER],
    windows: live.windows.map((window) => ({ ...window })),
    observedAt,
    freshness: 'live',
    billing: 'subscription',
    ...(live.resetCredits ? { resetCredits: live.resetCredits } : {}),
  };
}

/** Without a Codex sign-in there is nothing to spend, so stored reset credits no longer apply. */
function withoutResetCredits(record: ProviderUsage | null): ProviderUsage | null {
  if (!record?.resetCredits) return record;
  const { resetCredits: _signedOut, ...rest } = record;
  return rest;
}

function settledAnthropicQuota(result: PromiseSettledResult<AnthropicQuotaResult>): AnthropicQuotaResult {
  if (result.status === 'fulfilled') return result.value;
  return { snapshot: null, keepResets: true, notes: [t('ux.usage.claudeAccountFailed', { error: errorMessage(result.reason) })] };
}

/** Without a Claude login there is nothing to spend; a failed read keeps what was last known. */
function anthropicResets(quota: AnthropicQuotaResult, prior: ProviderUsage[], route?: string): UsageResetCredits | undefined {
  if (quota.resetCredits) return quota.resetCredits;
  if (!quota.keepResets) return undefined;
  const key = draftKey(ANTHROPIC_PROVIDER, 'subscription', route);
  return prior.find((row) => usageRecordKey(row) === key)?.resetCredits;
}

function codexDraft(drafts: Map<string, RowDraft>): RowDraft {
  const draft = ensureDraft(drafts, CODEX_PROVIDER, 'subscription');
  draft.quotaPolled = true;
  draft.modes.add(CODEX_PROVIDER);
  return draft;
}

function codexNotes(result: PromiseSettledResult<CodexQuotaResult>, reading: CodexQuotaResult): string[] {
  const failed = result.status === 'rejected'
    ? [t('ux.usage.codexFailed', { error: errorMessage(result.reason) })]
    : [];
  return reading.note ? [...failed, reading.note] : failed;
}

function applyCodexRecord(draft: RowDraft, record: ProviderUsage): void {
  draft.windows = record.windows;
  draft.observedAt = record.observedAt;
  draft.freshness = record.freshness;
  if (record.resetCredits) draft.resetCredits = record.resetCredits;
}

/** Legacy rows without billing can carry quota, but metered rows never establish a subscription.
 *  Every account's row counts here; `isAnthropicRouteRow` narrows to one login. */
function isAnthropicQuotaRow(record: ProviderUsage): boolean {
  return record.provider === ANTHROPIC_PROVIDER && record.billing !== 'api';
}

function isAnthropicRouteRow(record: ProviderUsage, route: string | undefined): boolean {
  return isAnthropicQuotaRow(record) && record.route === route;
}

function hasQuotaEvidence(record: ProviderUsage): boolean {
  return record.windows.length > 0 || record.observedAt !== null || record.resetCredits !== undefined;
}

/** Default modes and failure notes alone were enough to persist these old placeholders. */
function isEmptyAnthropicPlaceholder(record: ProviderUsage): boolean {
  return isAnthropicQuotaRow(record) && !hasQuotaEvidence(record) && record.spend === undefined;
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

/** Keep the last good quota reading rather than blanking the row on a failed cycle. */
function carryQuotaFromPrior(draft: RowDraft, prior: ProviderUsage[]): void {
  if (draft.windows.length > 0) return;
  const key = draftKey(draft.provider, draft.billing, draft.route);
  const match = prior.find((row) => usageRecordKey(row) === key)
    ?? (draft.route ? undefined : prior.find((row) => row.provider === draft.provider && row.billing === undefined));
  if (!match) return;
  draft.windows = match.windows.map((window) => ({ ...window }));
  draft.observedAt = match.observedAt;
  draft.freshness = match.observedAt === null ? 'never' : 'stale';
  if (match.resetCredits) draft.resetCredits = match.resetCredits;
}

/**
 * Deleting a row is only safe when the spend read actually answered. If it failed, retain history,
 * except empty Anthropic placeholders that never held any data.
 */
function guardDeletions(
  composed: ProviderUsage[],
  prior: ProviderUsage[],
  spend: PromiseSettledResult<LedgerSpendRow[]>,
): ProviderUsage[] {
  if (spend.status === 'fulfilled') return composed;
  const note = t('ux.usage.spendFailed', { error: errorMessage(spend.reason) });
  const seen = new Set(composed.map(usageRecordKey));
  const retained = prior
    .filter((row) => !seen.has(usageRecordKey(row)) && !isEmptyAnthropicPlaceholder(row))
    .map((row) => staleCopy(row, note));
  return [...composed.map((row) => (row.note ? row : { ...row, note })), ...retained];
}

async function readLedgerEntries(): Promise<readonly CostEntry[]> {
  return (await costRepo.readCosts()).entries;
}

export class UsageService {
  private readonly store: UsageServiceStore;
  private readonly signOuts: SubscriptionSignOuts;
  private readonly getAdapter: AdapterResolver;
  private readonly readLedger: () => Promise<readonly CostEntry[]>;
  private readonly billingOf: BillingOf;
  private readonly accountOf: AccountOf;
  private readonly now: () => Date;
  private readonly codexAccount: Pick<ResetAccount, 'readUsage'>;
  private readonly releaseThrottle: (provider: string, windows: QuotaReading[], route?: string) => Promise<unknown>;
  private readonly claudeAccount: Pick<ResetAccount, 'readUsage'>;
  private readonly claudeAccounts: () => ClaudeAccountReader[];

  constructor(dependencies: UsageServiceDependencies = {}) {
    this.store = dependencies.store ?? usageStore;
    this.signOuts = dependencies.signOuts ?? memorySignOuts();
    this.getAdapter = dependencies.getAdapter ?? (() => getPiEngineAdapter());
    this.readLedger = dependencies.readLedger ?? readLedgerEntries;
    this.billingOf = dependencies.billingOf ?? ((ref) => credentialInventory.billingOf(ref));
    this.accountOf = dependencies.accountOf ?? (() => null);
    this.claudeAccounts = dependencies.claudeAccounts ?? (() => []);
    this.now = dependencies.now ?? (() => new Date());
    this.codexAccount = dependencies.codexAccount ?? NO_ACCOUNT;
    this.claudeAccount = dependencies.claudeAccount ?? NO_ACCOUNT;
    this.releaseThrottle = dependencies.releaseThrottle ?? (async () => false);
  }

  async getStatus(): Promise<ProviderUsage[]> {
    return (await this.signedIn(await this.store.list())).map(visibleUsage);
  }

  /** Hides the subscription usage of a provider's default login, or of one account, once its login
   *  is gone. */
  async signOut(provider: string, connection?: string | null): Promise<void> {
    const key = signOutKey(provider, accountIdOf(connection));
    await this.signOuts.set(key, Math.floor(this.now().getTime() / 1000));
    await this.store.commit(await this.signedIn(await this.store.list()));
  }

  async signIn(provider: string, connection?: string | null): Promise<void> {
    await this.signOuts.set(signOutKey(provider, accountIdOf(connection)), null);
  }

  private async signedIn(records: ProviderUsage[]): Promise<ProviderUsage[]> {
    const signOuts = await this.signOuts.list();
    return records.filter((record) => !isSignedOut(record, signOuts));
  }

  async collect(): Promise<ProviderUsage[]> {
    const prior = await this.signedIn(await this.store.list());
    const accounts = this.claudeAccounts();
    const [[spend, quota, codex], accountQuotas] = await Promise.all([
      Promise.allSettled([this.readSpend(), this.readAnthropicQuota(this.claudeAccount), this.readCodexQuota()] as const),
      Promise.allSettled(accounts.map((account) => this.readAnthropicQuota(account.account, account.id))),
    ]);
    const drafts = new Map<string, RowDraft>();
    if (spend.status === 'fulfilled') applyLedgerRows(drafts, spend.value);
    else log.warn(`ledger spend read failed: ${errorMessage(spend.reason)}`);
    this.applyAnthropicQuota(drafts, quota, prior, {});
    accounts.forEach((account, index) => this.applyAnthropicQuota(
      drafts, accountQuotas[index]!, prior, { route: account.id, label: account.label },
    ));
    this.labelAccountRows(drafts, accounts);
    this.applyCodexQuota(drafts, codex, prior);
    const composed = [...drafts.values()].map(finalizeDraft);
    await this.store.commit(await this.signedIn(guardDeletions(composed, prior, spend)));
    return this.getStatus();
  }

  async refresh(): Promise<ProviderUsage[]> {
    return this.collect();
  }

  // ── Composition steps ────────────────────────────────────────

  /** Ledger rows of an account carry its route only; the label comes from the registry. */
  private labelAccountRows(drafts: Map<string, RowDraft>, accounts: ClaudeAccountReader[]): void {
    const labels = new Map(accounts.map((account) => [account.id, account.label]));
    for (const draft of drafts.values()) {
      if (draft.route && !draft.label) draft.label = labels.get(draft.route);
    }
  }

  private applyAnthropicQuota(
    drafts: Map<string, RowDraft>,
    result: PromiseSettledResult<AnthropicQuotaResult>,
    prior: ProviderUsage[],
    target: AnthropicTarget,
  ): void {
    const quota = settledAnthropicQuota(result);
    const inUse = drafts.has(draftKey(ANTHROPIC_PROVIDER, 'subscription', target.route))
      || prior.some((row) => isAnthropicRouteRow(row, target.route) && hasQuotaEvidence(row));
    if (!quota.snapshot && !inUse) return;
    const draft = ensureDraft(drafts, ANTHROPIC_PROVIDER, 'subscription', target.route);
    if (target.label) draft.label = target.label;
    draft.quotaPolled = true;
    draft.notes.push(...quota.notes);
    if (quota.snapshot) {
      draft.modes.add(target.route ?? SUBSCRIPTION_CONNECTION);
      draft.windows = quota.snapshot.windows;
      draft.observedAt = quota.snapshot.observedAt;
      draft.freshness = 'live';
    } else {
      carryQuotaFromPrior(draft, prior.filter((row) => !isEmptyAnthropicPlaceholder(row)));
    }
    draft.resetCredits = anthropicResets(quota, prior, target.route);
  }

  private applyCodexQuota(
    drafts: Map<string, RowDraft>,
    result: PromiseSettledResult<CodexQuotaResult>,
    prior: ProviderUsage[],
  ): void {
    const reading = result.status === 'fulfilled' ? result.value : { record: null };
    // Observation-only: with no reading and no history, Codex is simply not in use here.
    const inUse = drafts.has(draftKey(CODEX_PROVIDER, 'subscription'))
      || prior.some((row) => row.provider === CODEX_PROVIDER);
    if (!reading.record && !inUse) return;
    const draft = codexDraft(drafts);
    draft.notes.push(...codexNotes(result, reading));
    if (reading.record) applyCodexRecord(draft, reading.record);
    else carryQuotaFromPrior(draft, prior);
  }

  // ── Sources ──────────────────────────────────────────────────

  private async readSpend(): Promise<LedgerSpendRow[]> {
    return ledgerSpend(await this.readLedger(), this.billingOf, this.now(), this.accountOf);
  }

  /**
   * Ask the Codex account directly when a ChatGPT sign-in exists; otherwise, or when that read
   * fails, fall back to the row response headers last reported.
   */
  private async readCodexQuota(): Promise<CodexQuotaResult> {
    let live: AccountReading | null;
    try {
      live = await this.codexAccount.readUsage();
    } catch (error) {
      const note = t('ux.usage.codexAccountFailed', { error: errorMessage(error) });
      return { record: await this.readObservedCodexQuota(), note };
    }
    if (!live) return { record: withoutResetCredits(await this.readObservedCodexQuota()) };
    await this.releaseRecovered(CODEX_PROVIDER, live.windows, CODEX_PROVIDER);
    return { record: liveCodexUsage(live, Math.floor(this.now().getTime() / 1000)) };
  }

  private async readObservedCodexQuota(): Promise<ProviderUsage | null> {
    const adapter = this.getAdapter();
    if (!adapter.capabilities.has(Capability.Usage) || !adapter.getUsage) return null;
    const records = await adapter.getUsage(CODEX_SCOPE);
    return records?.find((record) => record.provider === CODEX_PROVIDER) ?? null;
  }

  /** A Claude login's own usage reading — the default's, or one account's; without a login there is
   *  none. */
  private async readAnthropicQuota(account: Pick<ResetAccount, 'readUsage'>, route?: string): Promise<AnthropicQuotaResult> {
    let live: AccountReading | null;
    try {
      live = await account.readUsage();
    } catch (error) {
      return { snapshot: null, keepResets: true, notes: [t('ux.usage.claudeAccountFailed', { error: errorMessage(error) })] };
    }
    if (!live) return { snapshot: null, keepResets: false, notes: [] };
    await this.releaseRecovered(ANTHROPIC_PROVIDER, live.windows, route ?? SUBSCRIPTION_CONNECTION);
    return {
      snapshot: {
        windows: live.windows.map((window) => ({ ...window })),
        observedAt: Math.floor(this.now().getTime() / 1000),
      },
      ...(live.resetCredits ? { resetCredits: live.resetCredits } : {}),
      keepResets: false,
      notes: [],
    };
  }

  private async releaseRecovered(provider: string, windows: QuotaReading[], route: string): Promise<void> {
    await this.releaseThrottle(provider, windows, route)
      .catch((error: unknown) => log.warn(`${provider} throttle release failed: ${errorMessage(error)}`));
  }
}

const claudeAccountClients = new Map<string, Pick<ResetAccount, 'readUsage'>>();

/** The daemon's Claude accounts, each with a usage client on its own config dir. */
function daemonClaudeAccounts(): ClaudeAccountReader[] {
  return credentialInventory.accounts()
    .filter((account): account is ClaudeAccountConnection => account.backend === 'claude')
    .map((account) => {
      let client = claudeAccountClients.get(account.id);
      if (!client) {
        client = claudeAccountClientFor(claudeAccountDir(account.id));
        claudeAccountClients.set(account.id, client);
      }
      return { id: account.id, label: account.label, account: client };
    });
}

function daemonAccountOf(ref: { backend: 'claude' | 'pi'; connection: string | null }): string | null {
  if (ref.backend !== 'claude' || !ref.connection) return null;
  return credentialInventory.accounts().some((account) => account.backend === 'claude' && account.id === ref.connection)
    ? ref.connection : null;
}

export const usageService = new UsageService({
  signOuts: {
    list: () => providerStateRepo.getSubscriptionSignOuts(),
    set: (provider, at) => providerStateRepo.setSubscriptionSignOut(provider, at),
  },
  codexAccount: codexAccountClient,
  claudeAccount: claudeAccountClient,
  claudeAccounts: daemonClaudeAccounts,
  accountOf: daemonAccountOf,
  releaseThrottle: releaseRecoveredQuota,
});
