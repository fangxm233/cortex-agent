import type { PlatformAdapter } from '@platform/index.js';
import { getSettings } from '@core/settings.js';
import { buildResumeReminder } from '@core/resume-reminder.js';
import type { EventBus } from '@events/index.js';
import { takeReadyResumes, type ResumeEntry } from '@domain/costs/resume-registry.js';
import { getThrottleState } from '@domain/costs/rate-limit-throttle.js';
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
  takeReady: (activeProviders: string[]) => ResumeEntry[];
  activeProviders: () => string[];
  route: (ctx: Parameters<typeof agentRunner.route>[0]) => Promise<void>;
  channelBusy: (channel: string) => boolean;
  acquireSessionUse: (sessionId: string) => Promise<(() => void) | null>;
  delay: (ms: number) => Promise<void>;
}

function defaultDeps(): ResumeDeps {
  return {
    takeReady: takeReadyResumes,
    activeProviders: () => getThrottleState().providers.map((provider) => provider.provider),
    route: (ctx) => agentRunner.route(ctx),
    // Subagent children ride on their parent's channel and outlive its turn; counting them read an
    // idle conversation as busy, which dropped its direct resume.
    channelBusy: (ch) => runRegistry.getOwnByChannel(ch).length > 0,
    acquireSessionUse: (sessionId) => acquireSessionUse(sessionId),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function entryKey(e: ResumeEntry): string {
  return e.kind === 'direct' ? `direct ${e.channel}` : `${e.kind} entry`;
}

type ResumeDispatch = (adapter: PlatformAdapter) => Promise<void>;

export function registerResumeWakeOnAgentSettle(
  bus: EventBus,
  adapter: PlatformAdapter,
  dispatch: ResumeDispatch = dispatchPendingResumes,
): () => void {
  const wake = () => { void dispatch(adapter); };
  const completed = bus.subscribe('agent.completed', wake);
  const failed = bus.subscribe('agent.failed', wake);
  const superseded = bus.subscribe('agent.superseded', wake);
  return () => {
    completed.unsubscribe();
    failed.unsubscribe();
    superseded.unsubscribe();
  };
}

/** Drain entries whose provider is no longer active and re-enter each target.
 *  Called after provider clears and during startup reconciliation. Never throws. */
export async function dispatchPendingResumes(adapter: PlatformAdapter, overrides: Partial<ResumeDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides };

  const activeProviders = deps.activeProviders();
  if (!isAutoResumeEnabled()) {
    const drained = deps.takeReady(activeProviders);
    if (drained.length > 0) log.info(`Auto-resume disabled — dropped ${drained.length} ready entry(ies)`);
    return;
  }

  const entries = deps.takeReady(activeProviders);
  if (entries.length === 0) return;
  log.info(`Rate-limit window reset — resuming ${entries.length} interrupted target(s)`);

  let dispatched = 0;
  for (const entry of entries) {
    if (entry.kind !== 'direct') {
      // A thread entry left over from before threads were retired has nothing left to resume.
      log.info(`Resume skip (${entryKey(entry)}): no longer resumable`);
      continue;
    }
    // A direct session is a live conversation — serialize per channel (no interleaved turns).
    if (deps.channelBusy(entry.channel)) {
      log.info(`Resume skip (${entryKey(entry)}): channel already has a running execution`);
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

async function resumeDirect(entry: Extract<ResumeEntry, { kind: 'direct' }>, adapter: PlatformAdapter, deps: ResumeDeps): Promise<void> {
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
