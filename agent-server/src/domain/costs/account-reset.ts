import { SUBSCRIPTION_CONNECTION, accountIdOf } from '@core/connections-file.js';
import { createLogger } from '@core/log.js';
import { claudeAccountDir } from '../connections/claude-account-dir.js';
import { claudeAccountClient, claudeAccountClientFor } from './claude-account.js';
import { codexAccountClient } from './codex-account.js';
import { clearThrottle } from './rate-limit-throttle.js';
import { throttleKey } from './throttle-key.js';
import type { ResetAccount, ResetProvider, ResetStatus } from './reset-account.js';
import { usageService } from './usage-service.js';
import { nextResetCredit, type ProviderUsage, type UsageWindow } from './usage-store.js';

const log = createLogger('account-reset');

/** An account answers a redeem before its usage reflects it (Codex: ~8 s observed), so the reading
 *  is re-polled for up to ~16 s rather than trusted immediately. */
const POLL_DELAYS_MS = [2_000, 3_000, 3_000, 4_000, 4_000];

const DEFAULT_ACCOUNTS: Record<ResetProvider, ResetAccount> = {
  'openai-codex': codexAccountClient,
  anthropic: claudeAccountClient,
};

export interface UsageResetResult {
  provider: ResetProvider;
  /** The account the reset was spent on; absent for the provider's default login. */
  connection?: string;
  status: ResetStatus;
  /** Window types the reset cleared, when the provider names them. */
  cleared: string[];
  /** Usage after the attempt; after a reset, the first reading that shows it (or the last tried). */
  usage: ProviderUsage[];
}

interface UsageReader {
  getStatus(): Promise<ProviderUsage[]>;
  refresh(): Promise<ProviderUsage[]>;
}

export interface UsageResetDeps {
  accounts?: Partial<Record<ResetProvider, ResetAccount>>;
  usage?: UsageReader;
  clearThrottle?: (provider: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  pollDelaysMs?: number[];
  now?: () => number;
}

interface ResolvedDeps extends Required<Omit<UsageResetDeps, 'accounts'>> {
  account: ResetAccount;
}

/** The login a redeem spends on: an injected account, one Claude account's own, or the default. */
function accountFor(provider: ResetProvider, connection: string | null, deps: UsageResetDeps): ResetAccount {
  if (deps.accounts?.[provider]) return deps.accounts[provider]!;
  if (!connection) return DEFAULT_ACCOUNTS[provider];
  if (provider !== 'anthropic') throw new Error(`Accounts of ${provider} cannot redeem a reset yet`);
  return claudeAccountClientFor(claudeAccountDir(connection));
}

function resolveDeps(provider: ResetProvider, connection: string | null, deps: UsageResetDeps): ResolvedDeps {
  return {
    account: accountFor(provider, connection, deps),
    usage: deps.usage ?? usageService,
    clearThrottle: deps.clearThrottle ?? clearThrottle,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pollDelaysMs: deps.pollDelaysMs ?? POLL_DELAYS_MS,
    now: deps.now ?? Date.now,
  };
}

/** Highest utilization among the windows a reset cleared (all of them when it did not say). */
function peak(windows: Pick<UsageWindow, 'type' | 'utilization'>[], cleared: string[]): number {
  return windows
    .filter((window) => cleared.length === 0 || cleared.includes(window.type))
    .reduce((max, window) => Math.max(max, window.utilization ?? 0), 0);
}

interface PollTarget {
  provider: ResetProvider;
  connection: string | null;
  before: number;
  cleared: string[];
  /** Epoch seconds the redeem was sent; an older observation cannot show it. */
  since: number;
}

function showsReset(records: ProviderUsage[], target: PollTarget): boolean {
  const row = records.find((record) => record.provider === target.provider && record.billing !== 'api'
    && (record.route ?? null) === target.connection);
  if (!row || row.observedAt === null || row.observedAt < target.since) return false;
  const after = peak(row.windows, target.cleared);
  return after === 0 || after < target.before;
}

/** A spent reset is irreversible: a failed follow-up read must not turn its result into an error. */
async function refreshedUsage(deps: ResolvedDeps): Promise<ProviderUsage[]> {
  try {
    return await deps.usage.refresh();
  } catch (error) {
    log.warn(`Usage refresh after a reset failed: ${(error as Error).message}`);
    return deps.usage.getStatus();
  }
}

async function pollUntilReset(target: PollTarget, deps: ResolvedDeps): Promise<ProviderUsage[]> {
  let usage = await deps.usage.getStatus();
  for (const delay of deps.pollDelaysMs) {
    await deps.sleep(delay);
    usage = await refreshedUsage(deps);
    if (showsReset(usage, target)) break;
  }
  return usage;
}

/** The reset lifts this login's limit alone: the account's route, else the default login's. */
function resetRoute(provider: ResetProvider, connection: string | null): string {
  return connection ?? (provider === 'anthropic' ? SUBSCRIPTION_CONNECTION : provider);
}

async function liftThrottle(provider: ResetProvider, connection: string | null, deps: ResolvedDeps): Promise<void> {
  try {
    await deps.clearThrottle(throttleKey(provider, resetRoute(provider, connection)));
  } catch (error) {
    log.warn(`Clearing the ${provider} throttle after a reset failed: ${(error as Error).message}`);
  }
}

async function redeemOnce(
  provider: ResetProvider,
  creditId: string | undefined,
  connection: string | null,
  deps: ResolvedDeps,
): Promise<UsageResetResult> {
  const owner = { provider, ...(connection ? { connection } : {}) };
  const current = await deps.account.readUsage();
  const listed = current?.resetCredits ? nextResetCredit(current.resetCredits) : null;
  const chosen = creditId ?? listed?.id;
  const since = Math.floor(deps.now() / 1000);
  const outcome = current ? await deps.account.redeemReset(chosen ?? undefined) : null;
  if (!current || !outcome) {
    return { ...owner, status: 'signed_out', cleared: [], usage: await deps.usage.getStatus() };
  }
  log.info(`Usage reset redeem: provider=${provider}, account=${connection ?? '(default)'}, status=${outcome.status}, cleared=${outcome.cleared.join(',')}`);
  if (outcome.status !== 'reset') return { ...owner, ...outcome, usage: await refreshedUsage(deps) };
  await liftThrottle(provider, connection, deps);
  const before = peak(current.windows, outcome.cleared);
  const usage = await pollUntilReset({ provider, connection, before, cleared: outcome.cleared, since }, deps);
  return { ...owner, ...outcome, usage };
}

const inFlight = new Map<string, Promise<UsageResetResult>>();

/**
 * Spend one banked usage-limit reset on a provider account — the given credit, else the one the
 * account offers next, else the one expiring first. `connection` names one of the provider's
 * accounts; absent, its default login. Only ever called on an explicit, confirmed user action. A
 * second request for the same account while one runs joins it instead of spending another reset.
 */
export function redeemUsageReset(
  provider: ResetProvider,
  creditId?: string,
  deps: UsageResetDeps = {},
  connection?: string | null,
): Promise<UsageResetResult> {
  const account = accountIdOf(connection);
  const key = `${provider}\u0000${account ?? ''}`;
  const running = inFlight.get(key);
  if (running) return running;
  const attempt = Promise.resolve()
    .then(() => redeemOnce(provider, creditId, account, resolveDeps(provider, account, deps)))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, attempt);
  return attempt;
}
