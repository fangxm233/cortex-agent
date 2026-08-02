// input:  continuation results, exact accounting, wait policy
// output: merged continuation events and bounded results
// pos:    Background continuation wait policy
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// Interactive turns hold their Slack status asynchronously (orchestration/lifecycle +
// bg-wait-guard). Thread/dispatch turns have no status message to hold — the step's
// RESULT is the deliverable — so they wait INLINE: the facade keeps the turn promise
// open until the spontaneous continuation completes, then resolves with the merged
// result. The thread's own busy bracket covers the wait (no extra track here). Ordinary
// callers use grace/cap bounds; supervised one-shot runs use completion-only mode and their
// process-stop boundary so ambient caps cannot publish success while work remains.

import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';
import type { ContinuationSink } from './types.js';
import type { NormalizedEvent } from './normalize/event-types.js';

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

/** Backend and result prerequisites shared by explicit and legacy inline waiting. */
export function canAwaitBgContinuation(
  backend: string,
  result: AgentResult | null | undefined,
  canRegisterSink: boolean,
): boolean {
  if (backend !== 'claude' || !canRegisterSink) return false;
  if (!result || result.rateLimited) return false;
  return remainingBg(result) > 0;
}

/** Legacy inline policy: settings-enabled thread turns wait; interactive turns do not. */
export function shouldAwaitBgInline(
  backend: string,
  threadId: string | null | undefined,
  result: AgentResult | null | undefined,
  canRegisterSink: boolean,
): boolean {
  if (!isBgContinuationEnabled() || !threadId) return false;
  return canAwaitBgContinuation(backend, result, canRegisterSink);
}

export interface WaitForBgOpts {
  proc: { setContinuationSink?: (sink: ContinuationSink) => void };
  baseResult: AgentResult;
  /** Continuation assistant text forwarded here (the step's transcript/stream callback). */
  onAssistantText?: ((text: string) => void) | null;
  onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  onContextUsage?: ((usage: ContextUsage) => void | Promise<void>) | null;
  onEvent?: ((event: NormalizedEvent) => void) | null;
  graceMs?: number;
  maxWaitMs?: number;
  /** Wait without ambient release timers until continuation completion or supervised stop. */
  completionOnly?: boolean;
  /** Process termination boundary required by completion-only waits. */
  stopPromise?: Promise<unknown>;
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
  const costReported = acc.costReported === undefined && cont.costReported === undefined
    ? undefined
    : acc.costReported === true || cont.costReported === true;
  return {
    ...acc,
    costReported,
    total_cost_usd: bothCostNull ? null : (acc.total_cost_usd ?? 0) + (cont.total_cost_usd ?? 0),
    num_turns: bothTurnsNull ? null : (acc.num_turns ?? 0) + (cont.num_turns ?? 0),
    finalOutput: cont.finalOutput || acc.finalOutput,
    rateLimited: acc.rateLimited || cont.rateLimited,
    rateLimitMessage: cont.rateLimitMessage ?? acc.rateLimitMessage,
    pendingBackgroundTasks: cont.pendingBackgroundTasks ?? 0,
    undeliveredBackgroundTasks: cont.undeliveredBackgroundTasks ?? 0,
  };
}

function continuationCostRecord(result: AgentResult): NormalizedEvent | null {
  const accounting = result.reportedAccounting;
  if (result.costReported !== true && accounting?.usageReported !== true) return null;
  return {
    type: 'cost_record', provider: 'anthropic', model: accounting?.model ?? 'unknown',
    tokens_in: accounting?.inputTokens ?? null,
    tokens_out: accounting?.outputTokens ?? null,
    prompt_tokens: accounting?.promptTokens ?? null,
    cached_tokens: accounting?.cachedTokens ?? null,
    cost_usd: result.costReported === true ? result.total_cost_usd : null,
  };
}

/**
 * Wait inline for the spontaneous background-task continuation of a turn that ended with
 * work remaining. Registers a ContinuationSink on the process and resolves with the merged
 * result when the continuation completes (chained continuations keep waiting). Observer failures
 * reject; otherwise the grace watchdog or max-wait cap resolves with the accumulated result.
 */
class BackgroundContinuationWait {
  private acc: AgentResult;
  private settled = false;
  private handle: unknown = null;
  private resolve!: (result: AgentResult) => void;
  private reject!: (error: unknown) => void;

  constructor(
    private readonly opts: WaitForBgOpts,
    private readonly timers: typeof realTimers,
    private readonly graceMs: number,
    private readonly maxWaitMs: number,
    private readonly completionOnly: boolean,
  ) {
    this.acc = opts.baseResult;
  }

  run(): Promise<AgentResult> {
    const promise = new Promise<AgentResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.opts.proc.setContinuationSink?.(this.sink());
      this.arm(
        this.opts.baseResult.pendingBackgroundTasks ?? 0,
        this.opts.baseResult.undeliveredBackgroundTasks ?? 0,
      );
    });
    if (this.opts.stopPromise) {
      void this.opts.stopPromise.then(
        () => this.stop(),
        error => this.stop(error),
      );
    }
    return promise;
  }

  private settle(complete: () => void): void {
    if (this.settled) return;
    this.settled = true;
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
    complete();
  }

  private finish(result: AgentResult): void {
    this.settle(() => this.resolve(result));
  }

  private stop(error?: unknown): void {
    const failure = error instanceof Error
      ? error
      : new Error('Agent process stopped before background continuation completed');
    this.settle(() => this.reject(failure));
  }

  private emit(event: NormalizedEvent): boolean {
    try { this.opts.onEvent?.(event); return true; }
    catch (error) { this.settle(() => this.reject(error)); return false; }
  }

  private arm(running: number, undelivered: number): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
    if (running > 0) {
      if (this.completionOnly) return;
      this.handle = this.timers.set(() => {
        log.info(`bg-wait cap (${this.maxWaitMs}ms) reached with ${running} task(s) still running — releasing the step`);
        this.finish(this.acc);
      }, this.maxWaitMs);
      return;
    }
    if (undelivered > 0) {
      if (this.completionOnly) return;
      this.handle = this.timers.set(() => {
        log.info(`bg-wait grace (${this.graceMs}ms) elapsed with no notification — releasing the step`);
        this.finish(this.acc);
      }, this.graceMs);
      return;
    }
    this.finish(this.acc);
  }

  private sink(): ContinuationSink {
    return {
      onAssistantText: (text, model) => this.assistantText(text, model),
      onToolUse: (name, input, id) => this.toolUse(name, input, id),
      onToolResult: (id, content, isError) => this.toolResult(id, content, isError),
      onContextUsage: (usage) => this.contextUsage(usage),
      onResult: (result) => this.result(result),
    };
  }

  private assistantText(text: string, model?: string | null): void {
    if (this.settled || !this.emit({ type: 'assistant_text', text, ...(model != null ? { model } : {}) })) return;
    try { this.opts.onAssistantText?.(text); }
    catch (error) { log.warn('bg-wait onAssistantText threw:', (error as Error).message); }
  }

  private toolUse(name: string, input: any, toolUseId?: string): void {
    const id = toolUseId ?? '';
    if (this.settled || !this.emit({ type: 'tool_use', name, input, toolUseId: id })) return;
    try { this.opts.onToolUse?.(name, input, id); }
    catch (error) { log.warn('bg-wait onToolUse threw:', (error as Error).message); }
  }

  private toolResult(toolUseId: string, content: string, isError: boolean): void {
    if (this.settled || !this.emit({ type: 'tool_result', toolUseId, content, ok: !isError })) return;
    try { this.opts.onToolResult?.(toolUseId, content, isError); }
    catch (error) { log.warn('bg-wait onToolResult threw:', (error as Error).message); }
  }

  private contextUsage(usage: ContextUsage): void {
    if (this.settled || !this.emit({ type: 'context_usage', ...usage })) return;
    try {
      void Promise.resolve(this.opts.onContextUsage?.(usage))
        .catch((error) => log.warn('bg-wait onContextUsage rejected:', (error as Error).message));
    } catch (error) {
      log.warn('bg-wait onContextUsage threw:', (error as Error).message);
    }
  }

  private result(continuation: AgentResult): void {
    if (this.settled) return;
    if (continuation.backgroundInterrupted) {
      if (this.completionOnly) this.stop();
      else this.finish({ ...this.acc, backgroundInterrupted: true });
      return;
    }
    const costRecord = continuationCostRecord(continuation);
    if (costRecord && !this.emit(costRecord)) return;
    if (!this.emit({
      type: 'turn_complete', numTurns: continuation.num_turns ?? 0,
      totalCostUsd: continuation.total_cost_usd ?? null,
    })) return;
    this.acc = mergeContinuation(this.acc, continuation);
    if (this.acc.rateLimited) { this.finish(this.acc); return; }
    const running = continuation.pendingBackgroundTasks ?? 0;
    const undelivered = continuation.undeliveredBackgroundTasks ?? 0;
    if (running + undelivered > 0) this.arm(running, undelivered);
    else this.finish(this.acc);
  }
}

export function waitForBgContinuation(opts: WaitForBgOpts): Promise<AgentResult> {
  const completionOnly = opts.completionOnly === true;
  if (completionOnly && !opts.stopPromise) {
    return Promise.reject(new Error('Completion-only background wait requires a stop promise'));
  }
  return new BackgroundContinuationWait(
    opts,
    opts.timers ?? realTimers,
    completionOnly ? 0 : (opts.graceMs ?? getBgGraceMs()),
    completionOnly ? 0 : (opts.maxWaitMs ?? getBgMaxWaitMs()),
    completionOnly,
  ).run();
}
