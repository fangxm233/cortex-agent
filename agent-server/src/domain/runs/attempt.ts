// input:  a resolved RunRequest, one attempt's engine selection and the route it runs under
// output: one attempt against a pooled engine session — its event stream, its two results, its kill
// pos:    Run layer — the unit a run's fallback chain is made of
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// A run is not one call to a backend. `AgentRun` walks a chain of attempts (domain/runs/fallback.ts);
// THIS is one link of that chain: acquire the pooled engine session for the spec, open a run on it,
// and hand back the stream plus the two results a caller can await. Everything downstream of
// `engine.run()` — the background phase, the watchdog, when the run is really over — belongs to the
// engine, so this module is wiring plus the two things that must happen per attempt and nowhere
// else: the frozen identity a benchmark journal links to, and cost attribution.
//
// Two results, deliberately: `foreground` is the turn the caller is waiting on, `settled` is the
// whole attempt with its background phase folded in. A terminal tally must read `settled` — reading
// `foreground` bills a run before its background work has finished paying. They settle at
// different TIMES, which is the point: under `hold` the foreground lands as soon as the engine
// reports the turn's result, while the stream stays open for the background phase behind it.

import { createLogger } from '@core/log.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { Backend, EngineRun, EngineSession, EngineSpec } from '../../agent-adapter/types.js';
import type { AwaitBackground } from '../../agent-adapter/continuation-phase.js';
import type { RunEvent } from '../../agent-adapter/run-events.js';
import type { EventObserver, NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import { recordCost, type CostAttribution } from '../costs/cost-tracker.js';
import type { ModeEnv } from '../agents/config.js';
import type { RunAttemptConfig } from '../agents/profile-manager.js';
import { engines } from './engines.js';
import { buildEngineSpec } from './engine-spec.js';
import type { RunRequest } from './request.js';
import {
  freezeProductionAttemptIdentity, type ProductionAttemptIdentityRecord,
} from '../benchmark/production-attempt-identity.js';
import { createProductionAttemptJournalSink } from '../benchmark/production-attempt-journal.js';

const log = createLogger('run-attempt');

export interface StartAttemptInput {
  request: RunRequest;
  /** Which engine this attempt selects — the profile itself, or one of its fallbacks. */
  attempt: RunAttemptConfig;
  /** The execution record the attempt is billed and attested under. */
  executionId: string | null;
  /** The resolved mode route (base URL + credentials) for this attempt. */
  route?: ModeEnv;
  /** Every RunEvent the engine produces, in order. The run fans them out; nothing else listens. */
  onEvent(event: RunEvent): void;
  /** Wire-level observers that need the untranslated record (benchmark evidence only). */
  requiredSinks?: EventObserver[];
}

export interface RunAttempt {
  readonly engine: EngineSession;
  readonly engineRun: EngineRun;
  readonly spec: EngineSpec;
  readonly backend: Backend;
  /** Frozen before the engine is touched, so evidence describes what was actually launched. */
  readonly identity: ProductionAttemptIdentityRecord | null;
  /** The caller's foreground await. */
  readonly foreground: Promise<AgentResult>;
  /** The whole attempt, background phase included. Terminal bookkeeping reads this one. */
  readonly settled: Promise<AgentResult>;
  readonly backendSessionId: string | null;
  kill(): boolean;
}

/** How long the engine keeps this attempt open for background work the backend started. */
function awaitBackgroundFor(request: RunRequest): AwaitBackground {
  return request.policy.background;
}

/** The cost columns every row of this attempt carries. Frozen once: an attempt cannot change
 *  which thread/task/trial it belongs to halfway through. */
function costAttribution(
  request: RunRequest,
  executionId: string | null,
  identity: ProductionAttemptIdentityRecord | null,
): Readonly<CostAttribution> {
  return Object.freeze({
    session_id: request.session.sessionId ?? request.session.backendSessionId ?? null,
    execution_id: identity?.execution_id ?? executionId ?? null,
    thread_id: identity?.thread_id ?? request.context.threadId ?? null,
    parent_thread_id: identity?.parent_thread_id ?? request.benchmark?.parentThreadId ?? null,
    root_thread_id: identity?.root_thread_id ?? request.benchmark?.rootThreadId ?? null,
    task_id: identity?.task_id ?? request.context.taskId ?? null,
    task_project: identity?.task_project ?? request.context.taskProject ?? null,
    dispatch_generation: identity?.dispatch_generation ?? request.context.taskGeneration ?? null,
    attempt_id: identity?.attempt_id ?? null,
    root_attempt_id: identity?.root_attempt_id ?? null,
    trial_id: identity?.trial_id ?? null,
    root_run_id: identity?.root_run_id ?? null,
  });
}

/** Record one backend cost event against this attempt. */
function recordAttemptCost(
  event: Extract<RunEvent, { type: 'cost_record' }>,
  input: StartAttemptInput,
  attribution: Readonly<CostAttribution>,
): void {
  if (input.request.policy.recordCost === false) return;
  void recordCost({
    ...attribution,
    project: input.request.context.project || 'general',
    trigger: input.request.context.trigger || 'unknown',
    cost_usd: event.cost_usd, backend: input.attempt.backend,
    mode: input.attempt.mode || 'api', source: 'estimate',
    input_tokens: event.input_tokens, output_tokens: event.output_tokens,
    prompt_tokens: event.prompt_tokens === undefined ? event.tokens_in : event.prompt_tokens,
    cache_read_tokens: event.cache_read_tokens,
    cache_creation_tokens: event.cache_creation_tokens,
    provider_requests: event.provider_requests,
    provider: event.provider || undefined, model: event.model || undefined,
  }).catch(err => log.warn('recordCost failed:', (err as Error)?.message ?? err));
}

/** The wire-level tap. Only evidence artifacts need the untranslated record; everything else
 *  reads the `RunEvent` stream, which is the one stream a run has. */
function normalizedTap(
  sinks: EventObserver[],
): ((event: NormalizedEvent) => void) | undefined {
  if (sinks.length === 0) return undefined;
  return (event: NormalizedEvent): void => {
    for (const sink of sinks) {
      try { void sink.onEvent(event); }
      catch (error) { log.warn('required sink failed:', (error as Error)?.message ?? error); }
    }
  };
}

/**
 * Close every wire-level sink once the attempt's stream has ended. This is where the benchmark
 * journal writes its index row (the journal is a per-attempt artifact; `onEvent` writes the body),
 * so skipping it leaves the evidence written but unindexed — which is how it was after the
 * process-seam removal dropped the event tee's close. A failing sink is logged, never allowed to
 * turn a finished run into a failed one.
 */
async function closeSinks(sinks: EventObserver[]): Promise<void> {
  for (const sink of sinks) {
    try { await sink.onClose?.(); }
    catch (error) { log.warn('required sink close failed:', (error as Error)?.message ?? error); }
  }
}

/** The synchronous twin of {@link closeSinks}, for a failure that happens before the event loop
 *  exists to await the close. The benchmark journal's `onClose` is synchronous and writes the
 *  attempt's index row, so a zero-event attempt must still be closed/indexed here. */
function closeSinksSync(sinks: EventObserver[]): void {
  for (const sink of sinks) {
    try { void sink.onClose?.(); }
    catch (error) { log.warn('required sink close failed:', (error as Error)?.message ?? error); }
  }
}

/**
 * The whole attempt: its accumulated result AND its drained stream. A rejection from either must
 * still let the stream drain (a surface may be mid-render), and a failing observer must not
 * swallow the real error.
 */
async function settleWithStream(
  engineRun: EngineRun, eventLoop: Promise<void>,
): Promise<AgentResult> {
  let result: AgentResult | null = null;
  let failure: unknown;
  try {
    [result] = await Promise.all([engineRun.settled, eventLoop]);
  } catch (error) {
    failure = error;
    try { await eventLoop; } catch (eventError) { failure = eventError; }
  }
  if (failure !== undefined) throw failure;
  return result as AgentResult;
}

function deferred<T>(): {
  promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Whether the caller's foreground await is released at the foreground turn's own result, before
 * the stream behind it has drained.
 *
 * Only `hold`. It is the one policy whose caller must have the reply while the run is STILL ALIVE:
 * an interactive surface renders it and then holds its status message open for whatever the
 * backend does next, so waiting for the stream to close would withhold the reply for the whole
 * background window (see `foreground` below).
 *
 * Every other policy settles the engine's result through `ContinuationPhase.settleRun`, which runs
 * at the phase's own finish — i.e. the stream is already ending — so releasing early would buy
 * nothing and cost a real ordering guarantee: a caller that awaits `foreground` would once again
 * see a run whose attempt sinks have not been closed (the benchmark journal writes its index row
 * in `onClose`). `inline` / `completion-only` additionally must carry the merged result, and
 * `none` ends at this same turn either way.
 */
function releasesAtForegroundResult(mode: AwaitBackground): boolean {
  return mode === 'hold';
}

/** Open one attempt. Synchronous: the caller holds the handle before the first event lands. */
export function startAttempt(input: StartAttemptInput): RunAttempt {
  const { request, attempt, executionId, route } = input;
  const spec = buildEngineSpec(request, attempt, { route, executionId });
  const identity = freezeProductionAttemptIdentity({
    adapterBackend: attempt.backend, spec, request, executionId,
    resolvedProfile: request.profile,
  });
  const journal = identity
    ? createProductionAttemptJournalSink({
      identity, spec,
      canonicalInstruction: request.benchmark?.identityDirective ?? '',
      message: request.prompt.text,
    })
    : null;
  const attribution = costAttribution(request, executionId, identity);
  const sinks: EventObserver[] = [...(journal ? [journal] : []), ...(input.requiredSinks ?? [])];
  const tap = normalizedTap(sinks);

  const awaitBackground = awaitBackgroundFor(request);
  const earlyRelease = releasesAtForegroundResult(awaitBackground);
  let engine: EngineSession;
  let engineRun: EngineRun;
  try {
    engine = engines.acquire(spec);
    engineRun = engine.run(
      { text: request.prompt.text, attachments: request.prompt.attachments },
      { awaitBackground, ...(tap ? { onNormalizedEvent: tap } : {}) },
    );
  } catch (error) {
    // A synchronous spawn/acquire failure never opens a stream, so the event loop that normally
    // closes the wire-level sinks never starts. Close them here so a zero-event attempt is still
    // linked: the journal's index row is written by `onClose`, and an attempt that never opened a
    // stream still owes that row.
    closeSinksSync(sinks);
    throw error;
  }

  // The foreground turn is over when the engine says so; an attempt bills only what it started.
  let foregroundOver = false;
  const foreground = deferred<AgentResult>();
  const eventLoop = (async (): Promise<void> => {
    try {
      for await (const event of engineRun.events) {
        if (event.type === 'cost_record' && !foregroundOver) {
          recordAttemptCost(event, input, attribution);
        }
        input.onEvent(event);
        if (event.type === 'foreground_result') {
          foregroundOver = true;
          // Released HERE — after the marker has been fanned out, and not one event later — but
          // only under `hold` (see `releasesAtForegroundResult`). The caller's turn is over; the
          // stream may still owe it a background phase, and the run stays alive and registered for
          // exactly as long as that takes (see `settled`). Waiting for the stream to drain instead
          // would hold an interactive reply for the whole background window — a still-running task
          // caps at 30 minutes and a `max-wait` expiry deliberately does not end the run, so the
          // reply could be withheld indefinitely.
          if (earlyRelease) foreground.resolve(event.result);
        }
      }
    } finally {
      await closeSinks(sinks);
    }
  })();

  const settled = settleWithStream(engineRun, eventLoop);
  // Whatever ends the attempt also ends the foreground await: a turn that failed, a stream that
  // closed without ever reporting a foreground result (cancel), and the `inline` policies whose
  // caller waits for the merged result all land here. Already-settled is a no-op, so the early
  // release above wins when it happened.
  void settled.then(foreground.resolve, foreground.reject);
  // Neither promise may become an unhandled rejection: the run attaches its handlers only once the
  // foreground turn has settled, and a retried attempt is abandoned without any handler at all.
  void foreground.promise.catch(() => undefined);

  return {
    engine, engineRun, spec, identity,
    backend: attempt.backend,
    foreground: foreground.promise,
    settled,
    get backendSessionId(): string | null { return engine.backendSessionId; },
    kill: () => engine.kill(),
  };
}
