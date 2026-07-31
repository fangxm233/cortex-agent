// input:  normalized events, agent process, observers
// output: synchronous tee with required-sink failure propagation
// pos:    Backend-neutral run event fan-out
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createLogger } from '@core/log.js';
import type { AgentProcess } from './types.js';
import type { NormalizedEvent } from './normalize/event-types.js';

const log = createLogger('event-tee');

export interface EventObserver {
  onEvent(event: NormalizedEvent): void;
  onClose?(): void | Promise<void>;
}

class TrajectoryWriteFailedError extends Error {
  readonly reason = 'trajectory_write_failed' as const;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(`Required trajectory sink failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TrajectoryWriteFailedError';
    this.cause = cause;
  }
}

function isRequiredFailure(error: unknown): error is TrajectoryWriteFailedError {
  return !!error && typeof error === 'object'
    && (error as { reason?: unknown }).reason === 'trajectory_write_failed';
}

function dispatchObservers(observers: EventObserver[], event: NormalizedEvent): void {
  for (const observer of observers) {
    try { observer.onEvent(event); }
    catch (error) { log.warn('run observer onEvent failed:', (error as Error)?.message ?? error); }
  }
}

function dispatchRequiredSinks(
  sinks: EventObserver[], event: NormalizedEvent, proc: AgentProcess,
): void {
  for (const sink of sinks) {
    try { sink.onEvent(event); }
    catch (cause) {
      proc.kill();
      throw new TrajectoryWriteFailedError(cause);
    }
  }
}

async function closeObservers(observers: EventObserver[]): Promise<void> {
  for (const observer of observers) {
    try { await observer.onClose?.(); }
    catch (error) { log.warn('run observer onClose failed:', (error as Error)?.message ?? error); }
  }
}

async function closeRequiredSinks(sinks: EventObserver[], proc: AgentProcess): Promise<void> {
  let failed = false;
  let firstCause: unknown;
  for (const sink of sinks) {
    try { await sink.onClose?.(); }
    catch (cause) {
      if (!failed) firstCause = cause;
      failed = true;
    }
  }
  if (!failed) return;
  proc.kill();
  throw new TrajectoryWriteFailedError(firstCause);
}

export interface RunEventTee {
  dispatch(event: NormalizedEvent): void;
  close(): Promise<void>;
}

export function createRunEventTee(
  proc: AgentProcess, observers: EventObserver[], requiredSinks: EventObserver[],
): RunEventTee {
  let closed = false;
  return {
    dispatch(event): void {
      dispatchObservers(observers, event);
      dispatchRequiredSinks(requiredSinks, event, proc);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeObservers(observers);
      await closeRequiredSinks(requiredSinks, proc);
    },
  };
}

export function createProcessCloser(proc: AgentProcess): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await proc.close().catch(() => {});
  };
}

export async function settleEventfulRun<T>(
  resultPromise: Promise<T>, eventLoop: Promise<void>,
  closeTee: () => Promise<void>, closeProcess: () => Promise<void>,
): Promise<T> {
  let result!: T;
  let failed = false;
  let failure: unknown;
  try { [result] = await Promise.all([resultPromise, eventLoop]); }
  catch (error) {
    failed = true;
    failure = error;
    await closeProcess();
    try { await eventLoop; }
    catch (eventError) { failure = eventError; }
  }
  try { await closeTee(); }
  catch (error) { failed = true; failure = error; }
  await closeProcess();
  if (failed) throw failure;
  return result;
}

export interface ConsumeEventStreamOptions {
  proc: AgentProcess;
  tee: RunEventTee;
  onEvent(event: NormalizedEvent): void | Promise<void>;
}

export async function consumeEventStream(options: ConsumeEventStreamOptions): Promise<void> {
  let legacyFailed = false;
  try {
    for await (const event of options.proc.events) {
      options.tee.dispatch(event);
      if (legacyFailed) continue;
      try { await options.onEvent(event); }
      catch (error) {
        legacyFailed = true;
        log.warn('legacy event callback failed:', (error as Error)?.message ?? error);
      }
    }
  } catch (error) {
    if (isRequiredFailure(error)) throw error;
    log.warn('event stream consumer failed:', (error as Error)?.message ?? error);
  }
}
