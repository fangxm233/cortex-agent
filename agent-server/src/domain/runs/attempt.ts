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
// `foreground` bills a run before its background work has finished paying.

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
} from './observers/production-attempt-identity.js';
import { createProductionAttemptJournalSink } from './observers/production-attempt-journal.js';

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
 * Await a result and the event loop together: a rejection from either must still let the stream
 * drain (a surface may be mid-render), and a failing observer must not swallow the real error.
 */
async function settleWithStream(
  engineRun: EngineRun, eventLoop: Promise<void>, which: 'result' | 'settled',
): Promise<AgentResult> {
  let result: AgentResult | null = null;
  let failure: unknown;
  try {
    [result] = await Promise.all([engineRun[which], eventLoop]);
  } catch (error) {
    failure = error;
    try { await eventLoop; } catch (eventError) { failure = eventError; }
  }
  if (failure !== undefined) throw failure;
  return result as AgentResult;
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
  const tap = normalizedTap([...(journal ? [journal] : []), ...(input.requiredSinks ?? [])]);

  const engine = engines.acquire(spec);
  const engineRun = engine.run(
    { text: request.prompt.text, attachments: request.prompt.attachments },
    { awaitBackground: awaitBackgroundFor(request), ...(tap ? { onNormalizedEvent: tap } : {}) },
  );

  // The foreground turn is over when the engine says so; an attempt bills only what it started.
  let foregroundOver = false;
  const eventLoop = (async (): Promise<void> => {
    for await (const event of engineRun.events) {
      if (event.type === 'cost_record') {
        if (!foregroundOver) recordAttemptCost(event, input, attribution);
      } else if (event.type === 'foreground_result') {
        foregroundOver = true;
      }
      input.onEvent(event);
    }
  })();

  return {
    engine, engineRun, spec, identity,
    backend: attempt.backend,
    foreground: settleWithStream(engineRun, eventLoop, 'result'),
    settled: settleWithStream(engineRun, eventLoop, 'settled'),
    get backendSessionId(): string | null { return engine.backendSessionId; },
    kill: () => engine.kill(),
  };
}
