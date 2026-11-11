import type { PlatformAdapter } from '@platform/index.js';
import { getSettings } from '@core/settings.js';
import { buildResumeReminder } from '@core/resume-reminder.js';
import type { EventBus } from '@events/index.js';
import {
  getResumeCount, pendingResumes, requeueResume, takeReadyResumes, type ResumeEntry,
} from '@domain/costs/resume-registry.js';
import { getThrottleState } from '@domain/costs/rate-limit-throttle.js';
import { throttleKey } from '@domain/costs/throttle-key.js';
import { startsOnFreeLogin } from '@domain/runs/account-failover.js';
import { resolveRunSelection } from '@domain/runs/config-resolver.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { agentRunner } from './agent-runner.js';
import { deliverToSession } from './session-gateway.js';
import { acquireSessionUse } from '@domain/sessions/session-use.js';
import { runRegistry } from '@core/run-registry.js';
import { createLogger } from '@core/log.js';

const log = createLogger('resume-dispatcher');

/** Gap between consecutive resume starts so we don't re-trip the limit / overload the API right
 *  after a window reset. Resumes begin one every 30s. */
const RESUME_STAGGER_MS = 30_000;

/** Auto-resume feature gate. */
export function isAutoResumeEnabled(): boolean {
  return getSettings().autoResume;
}

export interface ResumeDeps {
  takeReady: (activeProviders: string[], switchable: ReadonlySet<string>) => ResumeEntry[];
  activeProviders: () => string[];
  pending: () => ResumeEntry[];
  /** Whether a waiting conversation can go on now on a free login other than the one it hit. */
  canContinue: (entry: ResumeEntry) => Promise<boolean>;
  route: (ctx: Parameters<typeof agentRunner.route>[0]) => Promise<void>;
  channelBusy: (channel: string) => boolean;
  acquireSessionUse: (sessionId: string) => Promise<(() => void) | null>;
  delay: (ms: number) => Promise<void>;
  /** Puts back an entry that could not start yet. */
  requeue: (entry: ResumeEntry) => void;
}

function defaultDeps(): ResumeDeps {
  return {
    takeReady: takeReadyResumes,
    activeProviders: () => getThrottleState().providers.map((entry) => throttleKey(entry.provider, entry.route)),
    pending: pendingResumes,
    canContinue: sessionContinues,
    route: (ctx) => agentRunner.route(ctx),
    // Subagent children ride on their parent's channel and outlive its turn; counting them read an
    // idle conversation as busy, which dropped its direct resume.
    channelBusy: (ch) => runRegistry.getOwnByChannel(ch).length > 0,
    acquireSessionUse: (sessionId) => acquireSessionUse(sessionId),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    requeue: requeueResume,
  };
}

function entryKey(e: ResumeEntry): string {
  return `direct ${e.channel}`;
}

/** Read from the session's selection now: the login the conversation hit may still be limited
 *  while another of its logins is free. */
async function sessionContinues(entry: ResumeEntry): Promise<boolean> {
  if (!getSettings().accountFailover || !entry.trackSessionId) return false;
  try {
    const session = await sessionStore.getById(entry.trackSessionId);
    return !!session && startsOnFreeLogin(resolveRunSelection({ channel: entry.channel, session }));
  } catch (e) {
    log.warn(`Failover check failed (${entryKey(entry)}): ${(e as Error).message}`);
    return false;
  }
}

async function switchableChannels(deps: ResumeDeps): Promise<Set<string>> {
  const channels = new Set<string>();
  for (const entry of deps.pending()) {
    if (await deps.canContinue(entry)) channels.add(entry.channel);
  }
  return channels;
}

type ResumeDispatch = (adapter: PlatformAdapter) => Promise<void>;

export function registerResumeWakeOnAgentSettle(
  bus: EventBus,
  adapter: PlatformAdapter,
  dispatch: ResumeDispatch = dispatchPendingResumes,
  hasWaiting: () => boolean = () => getResumeCount() > 0,
): () => void {
  const wake = () => { void dispatch(adapter); };
  const completed = bus.subscribe('agent.completed', wake);
  const failed = bus.subscribe('agent.failed', wake);
  const superseded = bus.subscribe('agent.superseded', wake);
  // A waiting conversation may go on on another login the moment it is recorded or a login's
  // state changes; no window reset of its own will wake it.
  const changed = bus.subscribe('rate-limit.changed', () => { if (hasWaiting()) wake(); });
  return () => {
    completed.unsubscribe();
    failed.unsubscribe();
    superseded.unsubscribe();
    changed.unsubscribe();
  };
}

/** What this dispatch may start: every ready entry with auto-resume on. With it off the rest are
 *  dropped as before, but account failover's are kept — the user turned that on separately. */
function dispatchable(ready: ResumeEntry[]): ResumeEntry[] {
  if (isAutoResumeEnabled()) return ready;
  const kept = ready.filter((entry) => entry.failover === true);
  const dropped = ready.length - kept.length;
  if (dropped > 0) log.info(`Auto-resume disabled — dropped ${dropped} ready entry(ies)`);
  return kept;
}

/** A busy channel is skipped. A failover entry goes back for the next settled run to retry; any
 *  other was woken by its window reset and is dropped, as it always has been. */
function skipBusy(entry: ResumeEntry, deps: ResumeDeps): void {
  log.info(`Resume skip (${entryKey(entry)}): channel already has a running execution`);
  if (entry.failover) deps.requeue(entry);
}

/** Drain entries whose provider is no longer active and re-enter each target.
 *  Called after provider clears and during startup reconciliation. Never throws. */
export async function dispatchPendingResumes(adapter: PlatformAdapter, overrides: Partial<ResumeDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides };
  const switchable = await switchableChannels(deps);
  const entries = dispatchable(deps.takeReady(deps.activeProviders(), switchable));
  if (entries.length === 0) return;
  log.info(`Rate-limit window reset — resuming ${entries.length} interrupted target(s)`);

  let dispatched = 0;
  for (const entry of entries) {
    // A direct session is a live conversation — serialize per channel (no interleaved turns).
    if (deps.channelBusy(entry.channel)) {
      skipBusy(entry, deps);
      continue;
    }
    try {
      if (dispatched > 0) await deps.delay(RESUME_STAGGER_MS); // stagger START times, not completion
      // Awaited so the next dispatch sees the channel as busy.
      await resumeDirect(entry, adapter, deps);
      dispatched++;
    } catch (e) {
      log.error(`Resume failed (${entryKey(entry)}): ${(e as Error).message}`);
    }
  }
  log.info(`Resume complete — dispatched ${dispatched}/${entries.length}`);
}

async function resumeDirect(entry: ResumeEntry, adapter: PlatformAdapter, deps: ResumeDeps): Promise<void> {
  const notice = buildResumeReminder();
  log.info(`Resuming direct session on ${entry.channel}`);
  const release = entry.trackSessionId ? await deps.acquireSessionUse(entry.trackSessionId) : null;
  if (entry.trackSessionId && !release) {
    log.warn(`Resume skip (direct ${entry.channel}): session is missing or pending deletion`);
    return;
  }
  try {
    await deliverToSession({
      channel: entry.channel, text: notice, origin: 'resume',
      raw: { originalMessage: entry.userMessage },
      adapter, route: deps.route,
    });
  } finally {
    release?.();
  }
}
