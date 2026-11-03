// Warm-up for Claude's five-hour subscription window.
//
// The five-hour window opens with the first request after the previous one closed. Once it has
// closed and no Claude run has started for ten minutes, one tiny request through Claude Code opens
// the next window, so it closes five hours from now instead of five hours from whenever work
// resumes. Claude Code refreshes its login on the way, which keeps the account usage readable.
// Each subscription login (the default and every signed-in account) has its own window and is
// watched separately.

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { accountIdOf } from '@core/connections-file.js';
import { createLogger } from '@core/log.js';
import { runRegistry } from '@core/run-registry.js';
import { getSettings } from '@core/settings.js';
import { usageService } from '@domain/costs/usage-service.js';
import { usageStore, type ProviderUsage } from '@domain/costs/usage-store.js';
import { credentialInventory, resolveClaudeRoute, SUBSCRIPTION_CONNECTION } from '@domain/connections/index.js';
import { routeEnvFields } from '@domain/runs/engine-spec.js';
import { buildClaudeEnv } from '../agent-adapter/claude/spawn-args.js';
import { runWindowWarmup, type WindowWarmupLaunch } from '../agent-adapter/claude/window-warmup.js';

const log = createLogger('claude-window-warmup');

export const WARMUP_TICK_MS = 60_000;
/** How long the window must have been closed, with no Claude run since, before a warm-up. */
export const WARMUP_QUIET_MS = 10 * 60_000;
/** A failed warm-up is retried no sooner than this. */
export const WARMUP_RETRY_MS = 30 * 60_000;
const WARMUP_CHANNEL = 'claude-window-warmup';

/** The five-hour window's close in epoch ms; null when no window is open; undefined when the
 *  account has reported no five-hour window at all. */
export type WindowEnd = number | null | undefined;

export interface WarmupState {
  /** When this loop began watching (null while disabled): runs before it are unknown. */
  watchingSince: number | null;
  /** When the current window was seen closed; null while one is open. */
  idleSince: number | null;
  /** Last time a Claude run, or a warm-up, was seen. */
  lastActivity: number | null;
  lastAttempt: number | null;
}

export interface WarmupDeps {
  enabled(): boolean;
  /** The Claude subscription login a warm-up runs on (`subscription` or an account); null when
   *  there is none. */
  connection(): string | null;
  windowEnd(): Promise<WindowEnd>;
  claudeRunning(): boolean;
  warm(connection: string): Promise<void>;
  collectUsage(): Promise<unknown>;
  now(): number;
}

export function newWarmupState(): WarmupState {
  return { watchingSince: null, idleSince: null, lastActivity: null, lastAttempt: null };
}

export function fiveHourEnd(record: ProviderUsage | null): WindowEnd {
  const window = record?.windows.find((candidate) => candidate.type === 'five_hour');
  if (!window) return undefined;
  return window.resetsAt === null ? null : window.resetsAt * 1000;
}

/** A Claude run seen since the window closed has already opened the next one. */
function quietSinceClose(state: WarmupState, now: number): boolean {
  const idleSince = state.idleSince!;
  if (state.lastActivity !== null && state.lastActivity >= idleSince) return false;
  return now - Math.max(idleSince, state.watchingSince ?? now) >= WARMUP_QUIET_MS;
}

/** Fold one observation into the state; true when a warm-up is due now. */
function observe(state: WarmupState, end: WindowEnd, running: boolean, now: number): boolean {
  if (running) {
    state.lastActivity = now;
    return false;
  }
  if (end === undefined) return false;
  if (end !== null && end > now) {
    state.idleSince = null;
    return false;
  }
  state.idleSince = end ?? state.idleSince ?? now;
  return quietSinceClose(state, now)
    && (state.lastAttempt === null || now - state.lastAttempt >= WARMUP_RETRY_MS);
}

async function warmUp(state: WarmupState, deps: WarmupDeps, connection: string): Promise<boolean> {
  state.lastAttempt = deps.now();
  try {
    await deps.warm(connection);
  } catch (error) {
    log.warn(`warm-up failed: ${(error as Error).message}`);
    return false;
  }
  state.lastActivity = deps.now();
  log.info(`Claude five-hour window warmed up (${connection})`);
  await deps.collectUsage().catch((error) => log.warn(`usage refresh failed: ${(error as Error).message}`));
  return true;
}

/** One pass. Returns true when it sent a warm-up that succeeded. */
export async function tickWindowWarmup(state: WarmupState, deps: WarmupDeps = productionWarmupDeps): Promise<boolean> {
  if (!deps.enabled()) {
    state.watchingSince = null;
    return false;
  }
  const now = deps.now();
  state.watchingSince ??= now;
  const connection = deps.connection();
  if (!connection || !observe(state, await deps.windowEnd(), deps.claudeRunning(), now)) return false;
  return warmUp(state, deps, connection);
}

/** One pass over several subscription logins, each with its own state; a login no longer
 *  listed drops its state. */
export async function tickAllWindowWarmups(
  states: Map<string, WarmupState>,
  connections: string[],
  depsFor: (connection: string) => WarmupDeps,
): Promise<void> {
  for (const id of [...states.keys()]) if (!connections.includes(id)) states.delete(id);
  for (const connection of connections) {
    const state = states.get(connection) ?? newWarmupState();
    states.set(connection, state);
    await tickWindowWarmup(state, depsFor(connection));
  }
}

// --- Production wiring ---

/** The launch a turn on this connection would get: same config dir, route and credentials. It
 *  runs in a scratch directory so no project instructions ride along. */
export function warmupLaunch(connection: string): WindowWarmupLaunch {
  const route = resolveClaudeRoute(connection);
  const { sets, unsets } = routeEnvFields(route);
  const env = buildClaudeEnv(
    WARMUP_CHANNEL, randomUUID(), null, null, route.baseUrl, sets, undefined, undefined, unsets, route.configDir,
  );
  return { command: 'claude', env, cwd: tmpdir() };
}

/** A Claude run signed in as this account; `null` is the default login (and key connections). */
function claudeRunningAs(account: string | null): boolean {
  return runRegistry.getAll().some((run) => run.backend === 'claude' && (run.account ?? null) === account);
}

/** Warm-up deps for one subscription login: the default `subscription` or a signed-in account. */
export function connectionWarmupDeps(connection: string): WarmupDeps {
  const account = accountIdOf(connection);
  return {
    enabled: () => getSettings().claudeWindowWarmupEnabled,
    connection: () => connection,
    windowEnd: async () => fiveHourEnd(await usageStore.get('anthropic', 'subscription', account ?? undefined)),
    claudeRunning: () => claudeRunningAs(account),
    warm: (target) => runWindowWarmup(warmupLaunch(target)),
    collectUsage: () => usageService.collect(),
    now: () => Date.now(),
  };
}

export const productionWarmupDeps: WarmupDeps = {
  ...connectionWarmupDeps(SUBSCRIPTION_CONNECTION),
  connection: () => (credentialInventory.findClaude(SUBSCRIPTION_CONNECTION) ? SUBSCRIPTION_CONNECTION : null),
};

/** The subscription logins a warm-up can open a window for: the default, then each account. */
function warmupConnections(): string[] {
  return credentialInventory.claudeConnections()
    .filter((view) => view.kind === 'subscription' || view.kind === 'account')
    .map((view) => view.id);
}

const loopStates = new Map<string, WarmupState>();
let timer: NodeJS.Timeout | null = null;
let running = false;

async function tickProductionWarmups(): Promise<void> {
  if (!getSettings().claudeWindowWarmupEnabled) {
    for (const state of loopStates.values()) state.watchingSince = null;
    return;
  }
  await tickAllWindowWarmups(loopStates, warmupConnections(), connectionWarmupDeps);
}

function arm(): void {
  timer = setTimeout(async () => {
    timer = null;
    await tickProductionWarmups().catch((error) => log.error(`tick: ${(error as Error).message}`));
    if (running) arm();
  }, WARMUP_TICK_MS);
  timer.unref?.();
}

/** Start the loop. `claudeWindowWarmupEnabled` is read on every pass, so toggling it needs no restart. */
export function startClaudeWindowWarmup(): void {
  if (running) return;
  running = true;
  arm();
}

export function stopClaudeWindowWarmup(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
