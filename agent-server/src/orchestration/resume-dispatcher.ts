import type { PlatformAdapter } from '@platform/index.js';
import { getSettings } from '@core/settings.js';
import type { EventBus } from '@events/index.js';
import type { ThreadRecord } from '@core/types/thread-types.js';
import { recordResume, takeReadyResumes, type ResumeEntry } from '@domain/costs/resume-registry.js';
import { getThrottleState } from '@domain/costs/rate-limit-throttle.js';
import { agentRunner } from './agent-runner.js';
import { deliverToSession } from './session-gateway.js';
import { openThreadRun, type ThreadRunInput } from './thread-run/index.js';
import { resumeThreadRunInput } from './thread-callback.js';
import { trackPendingTask } from './busy-tracker.js';
import { threadStore } from '@store/thread-repo.js';
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

// Shared with the interrupted-thread-step rerun (domain/threads/prompt-builder); re-exported
// so existing callers/tests keep importing it from here.
import { buildResumeReminder } from '@core/resume-reminder.js';
export { buildResumeReminder };

export interface ResumeDeps {
  takeReady: (activeProviders: string[]) => ResumeEntry[];
  activeProviders: () => string[];
  route: (ctx: Parameters<typeof agentRunner.route>[0]) => Promise<void>;
  /** Runs the thread AND everything that follows it — the status-message refresh to its
   *  terminal/re-suspended/re-rate-limited state and the cascade to any parent (ThreadRun's
   *  render + settle). Without that tail the status message freezes at the last running step: the
   *  resumed run keeps updating it mid-flight, but nothing closes it out. Awaited (not detached)
   *  so the busy-gate bracket below counts this resume exactly once. */
  resumeThread: (input: ThreadRunInput) => Promise<unknown>;
  requeue: (entry: ResumeEntry) => void;
  buildResumeInput: (thread: ThreadRecord) => ThreadRunInput | null;
  getThread: (threadId: string) => ThreadRecord | null;
  channelBusy: (channel: string) => boolean;
  /** True if a DIRECT (interactive) session is live on the channel — i.e. an execution with no
   *  threadId. Only direct sessions force a channel to serialize (a Slack conversation cannot
   *  interleave two assistant turns). Threads are channel-parallel-safe, so a rate-limited thread
   *  only needs to avoid a live direct session, not other threads. */
  directSessionBusy: (channel: string) => boolean;
  acquireSessionUse: (sessionId: string) => Promise<(() => void) | null>;
  /** Daemon busy-gate bracket (busyTracker.trackPendingTask). The fire-and-forget thread resume
   *  must hold the gate for its ENTIRE run + settle — without it the resumed thread is invisible
   *  to the busy/idle IPC, and a pending .restart fires mid-stream and SIGKILLs app.ts
   *  (2026-07-09: three resumed threads killed). Direct resumes are NOT bracketed here:
   *  agentRunner.route tracks internally and double-counting would be redundant. */
  track: (delta: number) => void;
  delay: (ms: number) => Promise<void>;
}

function defaultDeps(): ResumeDeps {
  return {
    takeReady: takeReadyResumes,
    activeProviders: () => getThrottleState().providers.map((provider) => provider.provider),
    route: (ctx) => agentRunner.route(ctx),
    resumeThread: (input) => openThreadRun(input),
    requeue: recordResume,
    buildResumeInput: (thread) => resumeThreadRunInput(thread, 'resume-rate-limited'),
    getThread: (id) => threadStore.get(id),
    // Subagent children ride on their parent's channel and outlive its turn; counting them read an
    // idle conversation as busy, which dropped its direct resume and stalled threads behind it.
    channelBusy: (ch) => runRegistry.getOwnByChannel(ch).length > 0,
    directSessionBusy: (ch) => runRegistry.getOwnByChannel(ch).some(e => !e.threadId),
    acquireSessionUse: (sessionId) => acquireSessionUse(sessionId),
    track: trackPendingTask,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function entryKey(e: ResumeEntry): string {
  return e.kind === 'thread' ? `thread ${e.threadId}` : `direct ${e.channel}`;
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
    const skip = guardSkipReason(entry, deps);
    if (skip) {
      if (skip.requeue) deps.requeue(entry);
      log.info(`Resume skip (${entryKey(entry)}): ${skip.reason}`);
      continue;
    }
    try {
      if (dispatched > 0) await deps.delay(RESUME_STAGGER_MS); // stagger START times, not completion
      if (entry.kind === 'direct') {
        // Direct sessions are serial per channel — await so the next dispatch sees it as busy.
        await resumeDirect(entry, adapter, deps);
      } else {
        // Threads are channel-parallel-safe: fire-and-forget so multiple rate-limited threads on
        // the same channel resume concurrently instead of serializing behind the first one.
        // Hold the daemon busy gate for the whole detached run (incl. ThreadRun's render and
        // settle): +1 synchronously so the daemon observes busy before it can act on any idle;
        // -1 in finally so the gate never leaks. This bracket is why the ThreadRun below is
        // AWAITED rather than detached — openThreadRunDetached would take the gate a second time.
        // 2026-07-09: untracked resumed threads were SIGKILLed by a .restart-triggered restart
        // that fired while they were mid-stream.
        deps.track(+1);
        void resumeThread(entry, deps.getThread(entry.threadId)!, adapter, deps)
          .catch(e => log.error(`Resume failed (${entryKey(entry)}): ${(e as Error).message}`))
          .finally(() => deps.track(-1));
      }
      dispatched++;
    } catch (e) {
      log.error(`Resume failed (${entryKey(entry)}): ${(e as Error).message}`);
    }
  }
  log.info(`Resume complete — dispatched ${dispatched}/${entries.length}`);
}

/** Returns a human reason to skip, or null to proceed. Staleness is deliberately NOT a skip
 *  reason: a rate-limit window (e.g. a seven_day limit) can legitimately exceed any fixed age
 *  cutoff, so an entry is resumed whenever its provider resets regardless of wait duration.
 *  Only live-state guards apply. */
interface ResumeSkip {
  reason: string;
  requeue: boolean;
}

function guardSkipReason(entry: ResumeEntry, deps: ResumeDeps): ResumeSkip | null {
  if (entry.kind === 'direct') {
    // A direct session is a live conversation — serialize per channel (no interleaved turns).
    if (deps.channelBusy(entry.channel)) {
      return { reason: 'channel already has a running execution', requeue: false };
    }
    return null;
  }
  // A live direct session can finish after the provider window clears. Keep the thread durable;
  // the agent terminal-event wake retries it once the interactive turn leaves the registry.
  if (deps.directSessionBusy(entry.channel)) {
    return { reason: 'direct session active on channel', requeue: true };
  }
  const thread = deps.getThread(entry.threadId);
  if (!thread) return { reason: 'thread no longer exists', requeue: false };
  if (thread.status !== 'rate_limited') {
    return { reason: `thread is ${thread.status}`, requeue: false };
  }
  return null;
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

async function resumeThread(entry: Extract<ResumeEntry, { kind: 'thread' }>, thread: ThreadRecord, _adapter: PlatformAdapter, deps: ResumeDeps): Promise<void> {
  // Rebuild destination and status options from persisted thread metadata. Lifecycle hooks are
  // selected by the HookBus when the thread emits events. Unlike a direct session, the thread
  // re-runs its interrupted step from the original prompt, so
  // no <system-reminder> / userMessage overwrite is injected.
  const input = deps.buildResumeInput(thread);
  if (!input) {
    log.error(`Resume skip (thread ${entry.threadId}): could not rebuild run options (no adapter?)`);
    return;
  }
  log.info(`Resuming thread ${entry.threadId} on ${entry.channel}`);
  // ThreadRun owns the tail: the terminal (or re-suspended / re-rate-limited) status refresh and
  // the cascade to any parent, both inside this function's busy-gate bracket.
  await deps.resumeThread(input);
}
