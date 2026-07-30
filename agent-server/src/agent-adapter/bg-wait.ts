// input:  continuation sink, results, timers, runtime settings
// output: bounded wait forwarding tools and context snapshots
// pos:    Bridges thread-session background continuations
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// Interactive turns hold their Slack status asynchronously (orchestration/lifecycle +
// bg-wait-guard). Thread/dispatch turns have no status message to hold — the step's
// RESULT is the deliverable — so they wait INLINE: the facade keeps the turn promise
// open until the spontaneous continuation completes, then resolves with the merged
// result. The thread's own busy bracket covers the wait (no extra track here); the
// same grace/cap bounds apply so an undelivered notification or a never-ending task
// cannot hang a thread step forever.

import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';
import type { ContinuationSink } from './types.js';

const log = createLogger('bg-wait');

/** Background-task continuation feature gate. */
export function isBgContinuationEnabled(): boolean {
  return getSettings().bgContinuation;
}

const DEFAULT_GRACE_MS = 90_000;
const DEFAULT_MAX_WAIT_MS = 1_800_000;

function envMs(name: string, defMs: number): number {
  const raw = process.env[name];
  if (!raw) return defMs;
  const s = Number(raw);
  return Number.isFinite(s) && s > 0 ? s * 1000 : defMs;
}

/** Grace period for work-done-but-unnotified tasks (CORTEX_BG_GRACE_S, default 90s). */
export function getBgGraceMs(): number {
  return envMs('CORTEX_BG_GRACE_S', DEFAULT_GRACE_MS);
}

/** Max hold for still-running tasks (CORTEX_BG_WAIT_MAX_S, default 30min). */
export function getBgMaxWaitMs(): number {
  return envMs('CORTEX_BG_WAIT_MAX_S', DEFAULT_MAX_WAIT_MS);
}

/** Background work remaining on a turn result: running + finished-but-unnotified. */
export function remainingBg(result: { pendingBackgroundTasks?: number; undeliveredBackgroundTasks?: number } | null | undefined): number {
  if (!result) return 0;
  return (result.pendingBackgroundTasks ?? 0) + (result.undeliveredBackgroundTasks ?? 0);
}

/** Gate for the facade's inline wait: thread turns only (threadId set — interactive turns are
 *  held asynchronously by lifecycle instead), claude backend, sink capability, work remaining,
 *  feature flag on, not rate-limited (that goes to the retry path first). */
export function shouldAwaitBgInline(
  backend: string,
  threadId: string | null | undefined,
  result: AgentResult | null | undefined,
  canRegisterSink: boolean,
): boolean {
  if (!isBgContinuationEnabled()) return false;
  if (backend !== 'claude') return false;
  if (!threadId) return false;
  if (!canRegisterSink) return false;
  if (!result || result.rateLimited) return false;
  return remainingBg(result) > 0;
}

export interface WaitForBgOpts {
  proc: { setContinuationSink?: (sink: ContinuationSink) => void };
  baseResult: AgentResult;
  /** Continuation assistant text forwarded here (the step's transcript/stream callback). */
  onAssistantText?: ((text: string) => void) | null;
  onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  onContextUsage?: ((usage: ContextUsage) => void | Promise<void>) | null;
  graceMs?: number;
  maxWaitMs?: number;
  /** Injectable timers for tests. Production timers are unref'd. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

const realTimers = {
  set: (fn: () => void, ms: number): unknown => {
    const h = setTimeout(fn, ms);
    (h as any).unref?.();
    return h;
  },
  clear: (h: unknown): void => clearTimeout(h as NodeJS.Timeout),
};

/** Merge a continuation turn into the accumulated result: costs/turns summed, latest
 *  non-empty output wins, rate-limit and remaining counts taken from the continuation. */
function mergeContinuation(acc: AgentResult, cont: AgentResult): AgentResult {
  const bothCostNull = acc.total_cost_usd == null && cont.total_cost_usd == null;
  const bothTurnsNull = acc.num_turns == null && cont.num_turns == null;
  return {
    ...acc,
    total_cost_usd: bothCostNull ? null : (acc.total_cost_usd ?? 0) + (cont.total_cost_usd ?? 0),
    num_turns: bothTurnsNull ? null : (acc.num_turns ?? 0) + (cont.num_turns ?? 0),
    finalOutput: cont.finalOutput || acc.finalOutput,
    rateLimited: acc.rateLimited || cont.rateLimited,
    rateLimitMessage: cont.rateLimitMessage ?? acc.rateLimitMessage,
    pendingBackgroundTasks: cont.pendingBackgroundTasks ?? 0,
    undeliveredBackgroundTasks: cont.undeliveredBackgroundTasks ?? 0,
  };
}

/**
 * Wait inline for the spontaneous background-task continuation of a turn that ended with
 * work remaining. Registers a ContinuationSink on the process and resolves with the merged
 * result when the continuation completes (chained continuations keep waiting). Never
 * rejects; bounded by the grace watchdog (undelivered-only) or the max-wait cap (running):
 * on timeout it resolves with what has accumulated so far.
 */
export function waitForBgContinuation(opts: WaitForBgOpts): Promise<AgentResult> {
  const timers = opts.timers ?? realTimers;
  const graceMs = opts.graceMs ?? getBgGraceMs();
  const maxWaitMs = opts.maxWaitMs ?? getBgMaxWaitMs();

  return new Promise<AgentResult>((resolve) => {
    let acc = opts.baseResult;
    let settled = false;
    let handle: unknown = null;

    const finish = (result: AgentResult): void => {
      if (settled) return;
      settled = true;
      if (handle !== null) { timers.clear(handle); handle = null; }
      resolve(result);
    };

    const arm = (running: number, undelivered: number): void => {
      if (handle !== null) { timers.clear(handle); handle = null; }
      if (running > 0) {
        handle = timers.set(() => {
          log.info(`bg-wait cap (${maxWaitMs}ms) reached with ${running} task(s) still running — releasing the step`);
          finish(acc);
        }, maxWaitMs);
      } else if (undelivered > 0) {
        handle = timers.set(() => {
          log.info(`bg-wait grace (${graceMs}ms) elapsed with no notification — releasing the step`);
          finish(acc);
        }, graceMs);
      } else {
        finish(acc);
      }
    };

    opts.proc.setContinuationSink?.({
      onAssistantText: (text: string) => {
        if (settled) return;
        try { opts.onAssistantText?.(text); } catch (e) { log.warn('bg-wait onAssistantText threw:', (e as Error).message); }
      },
      onToolUse: (name: string, input: any, toolUseId?: string) => {
        if (settled) return;
        try { opts.onToolUse?.(name, input, toolUseId ?? ''); } catch (e) { log.warn('bg-wait onToolUse threw:', (e as Error).message); }
      },
      onToolResult: (toolUseId: string, content: string, isError: boolean) => {
        if (settled) return;
        try { opts.onToolResult?.(toolUseId, content, isError); } catch (e) { log.warn('bg-wait onToolResult threw:', (e as Error).message); }
      },
      onContextUsage: (usage: ContextUsage) => {
        if (settled) return;
        try { void Promise.resolve(opts.onContextUsage?.(usage)).catch((e) => log.warn('bg-wait onContextUsage rejected:', (e as Error).message)); }
        catch (e) { log.warn('bg-wait onContextUsage threw:', (e as Error).message); }
      },
      onResult: (cont: AgentResult) => {
        if (settled) return;
        if (cont.backgroundInterrupted) {
          // Process died mid-wait (restart / crash / kill): release the step with what we
          // have and surface the interruption to the caller.
          finish({ ...acc, backgroundInterrupted: true });
          return;
        }
        acc = mergeContinuation(acc, cont);
        if (acc.rateLimited) { finish(acc); return; }
        const running = cont.pendingBackgroundTasks ?? 0;
        const undelivered = cont.undeliveredBackgroundTasks ?? 0;
        if (running + undelivered > 0) arm(running, undelivered);
        else finish(acc);
      },
    });

    arm(opts.baseResult.pendingBackgroundTasks ?? 0, opts.baseResult.undeliveredBackgroundTasks ?? 0);
  });
}
