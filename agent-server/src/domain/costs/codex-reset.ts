import { CODEX_PROVIDER } from '@core/codex-quota.js';
import { createLogger } from '@core/log.js';
import { codexAccountClient, type CodexAccountClient, type CodexRedeemCode } from './codex-account.js';
import { clearThrottle } from './rate-limit-throttle.js';
import { usageService } from './usage-service.js';
import type { ProviderUsage, UsageWindow } from './usage-store.js';

const log = createLogger('codex-reset');

/** The account answers a redeem before its usage reflects it (observed ~8 s), so the reading is
 *  re-polled for up to ~16 s rather than trusted immediately. */
const POLL_DELAYS_MS = [2_000, 3_000, 3_000, 4_000, 4_000];

/** `unavailable`: Codex is not signed in, so nothing was attempted. */
export type CodexResetStatus = CodexRedeemCode | 'unavailable';

export interface CodexResetResult {
  status: CodexResetStatus;
  windowsReset: number;
  /** Usage after the attempt; after a reset, the first reading that shows it (or the last tried). */
  usage: ProviderUsage[];
}

interface UsageReader {
  getStatus(): Promise<ProviderUsage[]>;
  refresh(): Promise<ProviderUsage[]>;
}

export interface CodexResetDeps {
  account?: Pick<CodexAccountClient, 'readUsage' | 'redeemReset'>;
  usage?: UsageReader;
  clearThrottle?: (provider: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  pollDelaysMs?: number[];
}

type ResolvedDeps = Required<CodexResetDeps>;

function resolveDeps(deps: CodexResetDeps): ResolvedDeps {
  return {
    account: deps.account ?? codexAccountClient,
    usage: deps.usage ?? usageService,
    clearThrottle: deps.clearThrottle ?? clearThrottle,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pollDelaysMs: deps.pollDelaysMs ?? POLL_DELAYS_MS,
  };
}

function maxUtilization(windows: Pick<UsageWindow, 'utilization'>[]): number {
  return windows.reduce((max, window) => Math.max(max, window.utilization ?? 0), 0);
}

function showsReset(records: ProviderUsage[], before: number): boolean {
  const row = records.find((record) => record.provider === CODEX_PROVIDER && record.billing !== 'api');
  if (!row || row.freshness !== 'live') return false;
  const after = maxUtilization(row.windows);
  return after === 0 || after < before;
}

/** A spent reset is irreversible: a failed follow-up read must not turn its result into an error. */
async function refreshedUsage(deps: ResolvedDeps): Promise<ProviderUsage[]> {
  try {
    return await deps.usage.refresh();
  } catch (error) {
    log.warn(`Usage refresh after a Codex reset failed: ${(error as Error).message}`);
    return deps.usage.getStatus();
  }
}

async function pollUntilReset(before: number, deps: ResolvedDeps): Promise<ProviderUsage[]> {
  let usage = await deps.usage.getStatus();
  for (const delay of deps.pollDelaysMs) {
    await deps.sleep(delay);
    usage = await refreshedUsage(deps);
    if (showsReset(usage, before)) break;
  }
  return usage;
}

async function liftCodexThrottle(deps: ResolvedDeps): Promise<void> {
  try {
    await deps.clearThrottle(CODEX_PROVIDER);
  } catch (error) {
    log.warn(`Clearing the Codex throttle after a reset failed: ${(error as Error).message}`);
  }
}

async function redeemOnce(creditId: string | undefined, deps: ResolvedDeps): Promise<CodexResetResult> {
  const current = await deps.account.readUsage();
  const outcome = current
    ? await deps.account.redeemReset(creditId ?? current.resetCredits?.credits[0]?.id)
    : null;
  if (!current || !outcome) return { status: 'unavailable', windowsReset: 0, usage: await deps.usage.getStatus() };
  log.info(`Codex reset redeem: code=${outcome.code}, windowsReset=${outcome.windowsReset}`);
  if (outcome.code !== 'reset') {
    return { status: outcome.code, windowsReset: outcome.windowsReset, usage: await refreshedUsage(deps) };
  }
  await liftCodexThrottle(deps);
  const usage = await pollUntilReset(maxUtilization(current.windows), deps);
  return { status: 'reset', windowsReset: outcome.windowsReset, usage };
}

let inFlight: Promise<CodexResetResult> | null = null;

/**
 * Spend one banked Codex reset — the given credit, else the one expiring first. Only ever called
 * on an explicit user action. A second request while one is running joins it instead of spending
 * another credit.
 */
export function redeemCodexReset(creditId?: string, deps: CodexResetDeps = {}): Promise<CodexResetResult> {
  inFlight ??= redeemOnce(creditId, resolveDeps(deps)).finally(() => { inFlight = null; });
  return inFlight;
}
