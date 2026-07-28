// input:  active provider throttles, ready resume entries, thread runtime
// output: provider-ready direct and thread resume dispatch
// pos:    Re-enters interrupted work after its provider clears
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { PlatformAdapter, IncomingMessage } from '@platform/index.js';
import type { ThreadRecord, RunThreadOptions } from '@core/types/thread-types.js';
import { takeReadyResumes, type ResumeEntry } from '@domain/costs/resume-registry.js';
import { getThrottleState } from '@domain/costs/rate-limit-throttle.js';
import { agentRunner } from './agent-runner.js';
import { resumeRateLimitedThread } from '@domain/threads/runner.js';
import { buildResumeOptions, sealSuspendedStatusMsg, fireThreadCallback, closeResumedTaskLoop } from './thread-callback.js';
import { trackPendingTask } from './busy-tracker.js';
import { threadStore } from '@store/thread-repo.js';
import { runningExecutions } from '@core/running-executions.js';
import { createLogger } from '@core/log.js';

const log = createLogger('resume-dispatcher');

/** Gap between consecutive resume starts so we don't re-trip the limit / overload the API right
 *  after a window reset. Resumes begin one every 30s. */
const RESUME_STAGGER_MS = 30_000;

/** Auto-resume is on by default; disable with CORTEX_AUTO_RESUME=0 (or "false"). */
export function isAutoResumeEnabled(): boolean {
  const v = process.env.CORTEX_AUTO_RESUME;
  return v !== '0' && v !== 'false';
}

/** The continuation prompt injected into a resumed session/thread. Self-contained — the
 *  prior turn's content is already in the resumed session/thread history. */
export function buildResumeReminder(): string {
  return [
    '<system-reminder>',
    'The previous turn was interrupted by an API rate limit (the 5-hour window). That window has now reset; you may continue.',
    'Resume from where you left off: review the recent conversation context above, work out what is still unfinished, and finish it.',
    'Do not restart the task from scratch, and do not re-ask for information the user already provided. If the previous turn was in fact already complete, briefly confirm and stop.',
    'This message is only a resume signal; it should not change your original task.',
    '</system-reminder>',
  ].join('\n');
}

export interface ResumeDeps {
  takeReady: (activeProviders: string[]) => ResumeEntry[];
  activeProviders: () => string[];
  route: (ctx: Parameters<typeof agentRunner.route>[0]) => Promise<void>;
  resumeThread: (threadId: string, opts: RunThreadOptions) => Promise<unknown>;
  /** Settle a resumed thread once its run returns: refresh the live status message to its
   *  terminal/re-suspended/re-rate-limited summary and cascade completion to any parent.
   *  Without this the status message freezes at the last running step (the resumed run keeps
   *  updating it mid-flight, but nothing seals it at the end). Mirrors the DR-0014
   *  suspended-parent onSettled in thread-callback.defaultResume. */
  settleResumedThread: (threadId: string) => Promise<void>;
  buildResumeOptions: (thread: ThreadRecord) => RunThreadOptions | null;
  getThread: (threadId: string) => ThreadRecord | null;
  channelBusy: (channel: string) => boolean;
  /** True if a DIRECT (interactive) session is live on the channel — i.e. an execution with no
   *  threadId. Only direct sessions force a channel to serialize (a Slack conversation cannot
   *  interleave two assistant turns). Threads are channel-parallel-safe, so a rate-limited thread
   *  only needs to avoid a live direct session, not other threads. */
  directSessionBusy: (channel: string) => boolean;
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
    resumeThread: (id, opts) => resumeRateLimitedThread(id, opts),
    settleResumedThread: async (id) => {
      await sealSuspendedStatusMsg(id).catch((e) => log.warn(`seal status ${id}: ${(e as Error).message}`));
      await fireThreadCallback(id).catch((e) => log.error(`cascade callback ${id}: ${(e as Error).message}`));
      // A rate-limit-resumed worker bypasses the dispatch cycle, which is the only place
      // task.completed/task.blocked is published — re-emit it here so a manager/session waiting
      // on this task is woken (2026-06-29 finding: resumed leaf task left its manager suspended).
      await closeResumedTaskLoop(id).catch((e) => log.error(`close task loop ${id}: ${(e as Error).message}`));
    },
    buildResumeOptions: (thread) => buildResumeOptions(thread),
    getThread: (id) => threadStore.get(id),
    channelBusy: (ch) => runningExecutions.hasChannel(ch),
    directSessionBusy: (ch) => runningExecutions.getByChannel(ch).some(e => !e.threadId),
    track: trackPendingTask,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function entryKey(e: ResumeEntry): string {
  return e.kind === 'thread' ? `thread ${e.threadId}` : `direct ${e.channel}`;
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
    if (skip) { log.info(`Resume skip (${entryKey(entry)}): ${skip}`); continue; }
    try {
      if (dispatched > 0) await deps.delay(RESUME_STAGGER_MS); // stagger START times, not completion
      if (entry.kind === 'direct') {
        // Direct sessions are serial per channel — await so the next dispatch sees it as busy.
        await resumeDirect(entry, adapter, deps);
      } else {
        // Threads are channel-parallel-safe: fire-and-forget so multiple rate-limited threads on
        // the same channel resume concurrently instead of serializing behind the first one.
        // Hold the daemon busy gate for the whole detached run (incl. the settle inside
        // resumeThread): +1 synchronously so the daemon observes busy before it can act on any
        // idle; -1 in finally so the gate never leaks. Mirrors runThreadDetached
        // (thread-executor.ts) — 2026-07-09: untracked resumed threads were SIGKILLed by a
        // .restart-triggered restart that fired while they were mid-stream.
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
function guardSkipReason(entry: ResumeEntry, deps: ResumeDeps): string | null {
  if (entry.kind === 'direct') {
    // A direct session is a live conversation — serialize per channel (no interleaved turns).
    if (deps.channelBusy(entry.channel)) return 'channel already has a running execution';
    return null;
  }
  // Thread: channel-parallel-safe. Only avoid a live direct session (interactive turn) on the
  // channel; concurrent threads on the same channel are fine and must not skip each other.
  if (deps.directSessionBusy(entry.channel)) return 'direct session active on channel';
  const thread = deps.getThread(entry.threadId);
  if (!thread) return 'thread no longer exists';
  if (thread.status !== 'rate_limited') return `thread is ${thread.status}`;
  return null;
}

async function resumeDirect(entry: Extract<ResumeEntry, { kind: 'direct' }>, adapter: PlatformAdapter, deps: ResumeDeps): Promise<void> {
  const notice = buildResumeReminder();
  const message: IncomingMessage = {
    ref: { conduit: entry.channel, messageId: `resume_${Date.now()}` },
    text: notice,
    senderId: 'cortex-rate-limit-resume',
    isBot: false,
    kind: 'user',
    raw: { source: 'rate-limit-resume', originalMessage: entry.userMessage },
  };
  log.info(`Resuming direct session on ${entry.channel}`);
  await deps.route({ message, channel: entry.channel, adapter, threadAnchorId: null, hasFiles: false, userMessage: notice, agentMessage: notice });
}

async function resumeThread(entry: Extract<ResumeEntry, { kind: 'thread' }>, thread: ThreadRecord, _adapter: PlatformAdapter, deps: ResumeDeps): Promise<void> {
  // Rebuild RunThreadOptions (destination + dispatch task-status-check onEnd hook) from the
  // thread's persisted metadata — same machinery DR-0014 uses to re-enter suspended parents.
  // Unlike a direct session, a thread re-runs its interrupted step from the original prompt, so
  // no <system-reminder> / userMessage overwrite is injected.
  const opts = deps.buildResumeOptions(thread);
  if (!opts) {
    log.error(`Resume skip (thread ${entry.threadId}): could not rebuild run options (no adapter?)`);
    return;
  }
  log.info(`Resuming thread ${entry.threadId} on ${entry.channel}`);
  await deps.resumeThread(entry.threadId, opts);
  // The resumed run has returned terminal (or re-suspended / re-rate-limited). Seal the live
  // status message to its final state and cascade completion to any parent — mirrors the
  // DR-0014 suspended-parent onSettled. Without this the status message freezes at the last
  // running step ("Step N … ⏳") even though the thread ran to completion.
  await deps.settleResumedThread(entry.threadId);
}
