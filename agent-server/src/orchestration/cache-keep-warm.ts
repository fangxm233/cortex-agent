// Keep-warm for Claude prompt caches.
//
// A Claude subscription session's prompt cache lives one hour past its last read. A session that
// still expects a wake (an open waitpoint, a busy worker, a background `agent` run) is often woken
// later than that, and the wake then rewrites its whole context at the cache-write price. Every few
// minutes this sweep finds such sessions whose cache is nearing the hour and reads it once through
// a fork that leaves the session's transcript alone (agent-adapter/claude/cache-refresh.ts). A read
// restarts the hour, so the cache survives until the wake, up to `cacheKeepWarmHours` after the
// session last called the model.

import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import { resolveSpawnCwd } from '@core/paths.js';
import { runRegistry } from '@core/run-registry.js';
import { getSettings } from '@core/settings.js';
import { shortSessionId } from '@core/short-session-id.js';
import { effectiveBackendSessionId, sessionStore, type Session } from '@store/session-registry-repo.js';
import { hasRunningBackgroundRuns } from '@domain/agents/subagent/registry.js';
import type { EngineSelection } from '@domain/agents/engine-selection.js';
import { recordCost } from '@domain/costs/cost-tracker.js';
import { requestRoute, resolveRunSelection } from '@domain/runs/config-resolver.js';
import { buildEngineSpec } from '@domain/runs/engine-spec.js';
import { isTeamLead } from '@domain/sessions/team.js';
import {
  cacheRefreshLaunch, runCacheRefresh, type CacheRefreshResult,
} from '../agent-adapter/claude/cache-refresh.js';
import { lastCacheTouch, lastModelActivity, noteCacheRefresh } from '../agent-adapter/claude/cache-touch.js';
import { computeTranscriptPath } from '../agent-adapter/claude/transcript-path.js';
import { conduitQueues, enqueueAndWait } from './conduit-queue.js';
import { conversationEngineRequest } from './conversation-request.js';
import { countOpenWaitpoints, describeTeam, isWorkerBusy, type WorkerView } from './team-state.js';

const log = createLogger('cache-keep-warm');

export const KEEP_WARM_SWEEP_MS = 5 * 60_000;
/** Refresh once the cache is this old: ten minutes short of its one-hour lifetime. */
export const KEEP_WARM_REFRESH_AGE_MS = 50 * 60_000;
/** Below this a cold rewrite is cheap enough that keeping the cache is not worth a request. */
export const KEEP_WARM_MIN_CONTEXT_TOKENS = 100_000;
const HOUR_MS = 60 * 60_000;

export type KeepWarmSettings = { hours: number; subscriptionModes: readonly string[] };

export interface KeepWarmTarget {
  session: Session;
  backendSessionId: string;
  selection: EngineSelection;
}

export interface KeepWarmCostEntry {
  project: string;
  trigger: 'cache-refresh';
  cost_usd: number;
  backend: 'claude';
  mode: string;
  source: 'estimate';
  input_tokens: number;
  output_tokens: number;
  prompt_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  provider: 'anthropic';
  model: string;
  session_id: string;
}

export interface KeepWarmDeps {
  listSessions(): Promise<Session[]>;
  settings(): KeepWarmSettings;
  /** The selection the session's next turn would run under; throws when it cannot resume there. */
  selection(session: Session): EngineSelection;
  transcriptPath(backendSessionId: string): string;
  lastActivity(transcriptPath: string): number | null;
  lastTouch(transcriptPath: string, backendSessionId: string): number | null;
  /** Something will still wake the session: an open waitpoint, a busy worker, a background run. */
  hasWakeSource(session: Session): Promise<boolean>;
  /** A turn is live or queued on the channel. A background hold alone is not busy. */
  busy(channel: string): boolean;
  runQueued<T>(channel: string, fn: () => Promise<T>): Promise<T>;
  refresh(target: KeepWarmTarget): Promise<CacheRefreshResult>;
  noteRefresh(backendSessionId: string, at: number): void;
  recordCost(entry: KeepWarmCostEntry): Promise<void>;
  now(): number;
}

function largeClaudeSession(session: Session): string | null {
  const used = session.contextUsage?.usedTokens ?? 0;
  if (session.backend !== 'claude' || used < KEEP_WARM_MIN_CONTEXT_TOKENS) return null;
  return effectiveBackendSessionId(session);
}

/** Only a subscription mode caches for an hour; elsewhere the cache is gone long before a refresh. */
function subscriptionSelection(
  session: Session, deps: KeepWarmDeps, modes: readonly string[],
): EngineSelection | null {
  let selection: EngineSelection;
  try { selection = deps.selection(session); } catch { return null; }
  return selection.backend === 'claude' && modes.includes(selection.mode) ? selection : null;
}

/** Due when the cache nears the hour, while the last model activity is within the cap. */
function refreshDue(target: KeepWarmTarget, deps: KeepWarmDeps, hours: number): boolean {
  const transcript = deps.transcriptPath(target.backendSessionId);
  const active = deps.lastActivity(transcript);
  if (active === null) return false;
  const now = deps.now();
  const touched = deps.lastTouch(transcript, target.backendSessionId) ?? active;
  return now - active <= hours * HOUR_MS && now - touched >= KEEP_WARM_REFRESH_AGE_MS;
}

/** The session's refresh target when it is due one now, else null. Cheapest checks first. */
export async function dueTarget(
  session: Session, deps: KeepWarmDeps, settings: KeepWarmSettings,
): Promise<KeepWarmTarget | null> {
  const backendSessionId = largeClaudeSession(session);
  if (!backendSessionId || !(await deps.hasWakeSource(session))) return null;
  const selection = subscriptionSelection(session, deps, settings.subscriptionModes);
  if (!selection) return null;
  const target = { session, backendSessionId, selection };
  return refreshDue(target, deps, settings.hours) && !deps.busy(session.channel) ? target : null;
}

function costEntry(target: KeepWarmTarget, result: CacheRefreshResult): KeepWarmCostEntry {
  const { usage } = result;
  return {
    project: target.session.projectId ?? 'general',
    trigger: 'cache-refresh',
    cost_usd: result.costUsd,
    backend: 'claude',
    mode: target.selection.mode,
    source: 'estimate',
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_creation_tokens: usage.cacheWriteTokens,
    provider: 'anthropic',
    model: target.selection.model,
    session_id: target.session.sessionId,
  };
}

/** One refresh, queued on the session's channel so a wake that arrives meanwhile waits for it. A
 *  turn that got into the queue first has already warmed the cache, so the refresh then skips. */
async function refreshTarget(
  target: KeepWarmTarget, deps: KeepWarmDeps, settings: KeepWarmSettings,
): Promise<boolean> {
  const id = shortSessionId(target.session.sessionId);
  let result: CacheRefreshResult | null;
  try {
    result = await deps.runQueued(target.session.channel, async () =>
      refreshDue(target, deps, settings.hours) ? deps.refresh(target) : null);
  } catch (error) {
    log.warn(`cache refresh ${id} failed: ${(error as Error).message}`);
    return false;
  }
  if (!result) return false;
  deps.noteRefresh(target.backendSessionId, deps.now());
  await deps.recordCost(costEntry(target, result))
    .catch((error) => log.warn(`cache refresh ${id} cost not recorded: ${(error as Error).message}`));
  const { cacheReadTokens, cacheWriteTokens } = result.usage;
  log.info(`cache refresh ${id}: read ${cacheReadTokens}, write ${cacheWriteTokens}, `
    + `$${result.costUsd.toFixed(3)}, ${(result.durationMs / 1000).toFixed(1)}s`);
  return true;
}

/** One pass, one session at a time. Returns how many sessions were refreshed. */
export async function sweepCacheKeepWarm(deps: KeepWarmDeps = productionKeepWarmDeps): Promise<number> {
  const settings = deps.settings();
  if (settings.hours <= 0) return 0;
  let refreshed = 0;
  for (const session of await deps.listSessions()) {
    const target = await dueTarget(session, deps, settings);
    if (target && await refreshTarget(target, deps, settings)) refreshed++;
  }
  return refreshed;
}

// --- Production wiring ---

export interface WakeSourceDeps {
  backgroundRuns(sessionId: string): boolean;
  openWaitpoints(sessionId: string, channel: string): Promise<number>;
  isLead(session: Session): boolean;
  team(leadSessionId: string): Promise<WorkerView[]>;
}

const productionWakeSourceDeps: WakeSourceDeps = {
  backgroundRuns: hasRunningBackgroundRuns,
  openWaitpoints: countOpenWaitpoints,
  isLead: (session) => isTeamLead(session),
  team: (leadSessionId) => describeTeam(leadSessionId),
};

/** A lead's workers that still owe it a report: running, waiting on a question, or on a waitpoint. */
async function hasPendingWorker(session: Session, deps: WakeSourceDeps): Promise<boolean> {
  if (!deps.isLead(session)) return false;
  const team = await deps.team(session.sessionId);
  return team.some((view) => isWorkerBusy(view) || view.status === 'external');
}

/** Whether something will still wake the session: a background `agent` run of its own, an open
 *  waitpoint it owns, or (as a lead) a worker that has not reported back. */
export async function hasWakeSource(
  session: Session, deps: WakeSourceDeps = productionWakeSourceDeps,
): Promise<boolean> {
  if (deps.backgroundRuns(session.sessionId)) return true;
  if (await deps.openWaitpoints(session.sessionId, session.channel) > 0) return true;
  return hasPendingWorker(session, deps);
}

/** The fork runs under the request the session's next turn would: same agent, selection, policy
 *  and route, so its argv and env match that turn's. Its execution id is its own. */
function refreshSession(target: KeepWarmTarget): Promise<CacheRefreshResult> {
  const { session, backendSessionId } = target;
  const request = conversationEngineRequest({
    ids: { sessionId: session.sessionId, backendSessionId, projectId: session.projectId ?? 'general' },
    channel: session.channel, session, trigger: 'cache-refresh',
  });
  const spec = buildEngineSpec(request, request.selection, {
    route: requestRoute(request, request.selection),
    executionId: `cache-refresh-${randomUUID()}`,
  });
  return runCacheRefresh(cacheRefreshLaunch(spec));
}

export const productionKeepWarmDeps: KeepWarmDeps = {
  listSessions: () => sessionStore.listRecentSessions(Number.MAX_SAFE_INTEGER),
  settings: () => {
    const settings = getSettings();
    return { hours: settings.cacheKeepWarmHours, subscriptionModes: settings.anthropicSubscriptionModes };
  },
  selection: (session) => resolveRunSelection({ channel: session.channel, session }),
  // A conversation turn spawns in the default cwd, which is where its transcript lives.
  transcriptPath: (backendSessionId) => computeTranscriptPath(resolveSpawnCwd(), backendSessionId),
  lastActivity: lastModelActivity,
  lastTouch: lastCacheTouch,
  hasWakeSource: (session) => hasWakeSource(session),
  busy: (channel) => runRegistry.hasChannel(channel) || conduitQueues.has(channel),
  runQueued: enqueueAndWait,
  refresh: refreshSession,
  noteRefresh: noteCacheRefresh,
  recordCost,
  now: () => Date.now(),
};

let timer: NodeJS.Timeout | null = null;
let running = false;

function arm(): void {
  timer = setTimeout(async () => {
    timer = null;
    await sweepCacheKeepWarm().catch((error) => log.error(`sweep: ${(error as Error).message}`));
    if (running) arm();
  }, KEEP_WARM_SWEEP_MS);
  timer.unref?.();
}

/** Start the periodic keep-warm sweep. `cacheKeepWarmHours` is read on every pass, so turning it
 *  off or on takes effect without a restart. */
export function startCacheKeepWarm(): void {
  if (running) return;
  running = true;
  arm();
}

/** Stop the loop before the stores flush: a pass records costs. */
export function stopCacheKeepWarm(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
