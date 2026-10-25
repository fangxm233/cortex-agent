import { onSettingsChange } from '@core/settings.js';
import { buildEnvelope } from './envelope.js';
import { telemetryGate, isTelemetryActive, type TelemetryGate } from './gate.js';
import { appendToOutbox, settleOutbox, takeOutbox, wipeOutbox } from './outbox.js';
import type { HeartbeatEvent, TelemetryEvent } from './schema.js';
import { readTelemetryState, updateTelemetryState } from './state.js';
import { chunkEvents, postBatch, UploadBackoff, type FetchLike } from './uploader.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FIRST_DELAY_MS = 10 * 60 * 1000;
const STARTUP_FLUSH_DELAY_MS = 30_000;
const URGENT_FLUSH_DELAY_MS = 2_000;

export interface TelemetryServiceOptions {
  /** Builds the daily heartbeat; null skips this round. */
  collectHeartbeat: () => Promise<HeartbeatEvent | null>;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Delay after boot before the first heartbeat or rollup upload. */
  firstDelayMs?: number;
}

interface Running {
  options: TelemetryServiceOptions;
  bootAt: number;
  unsubscribe: () => void;
}

/** Hooks other telemetry modules register for the moments the service drives. */
export interface TelemetryLifecycleHooks {
  /** Persist in-memory aggregates (periodic tick and shutdown). */
  persist?: () => void;
  /** Turn completed days into outbox events. */
  finalize?: (now: number) => void | Promise<void>;
  /** Delete every local file the hook's module owns. */
  wipe?: () => void;
}

const hooks: TelemetryLifecycleHooks[] = [];
let backoff = new UploadBackoff();
let running: Running | null = null;
let flushing: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushDueAt = 0;

export function registerTelemetryHooks(next: TelemetryLifecycleHooks): void {
  hooks.push(next);
}

function now(): number {
  return running?.options.now?.() ?? Date.now();
}

function runHooks(pick: (hook: TelemetryLifecycleHooks) => (() => void) | undefined): void {
  for (const hook of hooks) {
    try { pick(hook)?.(); } catch { /* one module's failure never stops the others */ }
  }
}

/** Delete the outbox and every aggregate. The install id and state.json stay. */
export function wipeLocalTelemetry(): void {
  try { wipeOutbox(); } catch { /* best effort */ }
  runHooks((hook) => hook.wipe);
}

/** Queue one event. Urgent events (crashes) trigger an upload within seconds. */
export function recordTelemetryEvent(event: TelemetryEvent, opts: { urgent?: boolean } = {}): boolean {
  if (!isTelemetryActive()) return false;
  const appended = appendToOutbox(event);
  if (appended && opts.urgent) scheduleFlush(URGENT_FLUSH_DELAY_MS);
  return appended;
}

/** Arm the flush timer; an earlier deadline (a crash during the startup delay) replaces a later one. */
function scheduleFlush(delayMs: number): void {
  const dueAt = now() + delayMs;
  if (!running || (flushTimer && flushDueAt <= dueAt)) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushDueAt = dueAt;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushTelemetry();
  }, delayMs);
  flushTimer.unref?.();
}

async function sendAll(gate: TelemetryGate, events: TelemetryEvent[]): Promise<TelemetryEvent[]> {
  const batches = chunkEvents(events);
  for (let i = 0; i < batches.length; i += 1) {
    const envelope = buildEnvelope(gate.channel, new Date(now()));
    const outcome = await postBatch(gate.endpoint!, envelope, batches[i], running?.options.fetchImpl);
    if (outcome === 'retry') {
      backoff.failed();
      return batches.slice(i).flat();
    }
  }
  backoff.succeeded();
  return [];
}

async function doFlush(): Promise<void> {
  const gate = telemetryGate();
  if (!gate.active || !gate.endpoint || !backoff.ready()) return;
  const events = takeOutbox();
  settleOutbox(events.length === 0 ? [] : await sendAll(gate, events));
}

/** Upload whatever the outbox holds. Never throws; concurrent calls share one attempt. */
export function flushTelemetry(): Promise<void> {
  flushing ??= doFlush().catch(() => undefined).finally(() => { flushing = null; });
  return flushing;
}

async function queueHeartbeatIfDue(): Promise<void> {
  const last = Date.parse(readTelemetryState().lastHeartbeatAt ?? '') || 0;
  if (!running || now() - last < DAY_MS) return;
  const heartbeat = await running.options.collectHeartbeat().catch(() => null);
  if (!heartbeat || !recordTelemetryEvent(heartbeat)) return;
  updateTelemetryState((state) => ({ ...state, lastHeartbeatAt: new Date(now()).toISOString() }));
}

async function finalizeAll(at: number): Promise<void> {
  for (const hook of hooks) {
    try { await hook.finalize?.(at); } catch { /* the next tick retries */ }
  }
}

/** The periodic job: persist aggregates, then (after the boot delay) queue and upload. */
export async function telemetryTick(): Promise<void> {
  if (!isTelemetryActive()) return wipeLocalTelemetry();
  runHooks((hook) => hook.persist);
  if (!running || now() - running.bootAt < firstDelayMs(running.options)) return;
  await finalizeAll(now());
  await queueHeartbeatIfDue();
  await flushTelemetry();
}

function firstDelayMs(options: TelemetryServiceOptions): number {
  if (options.firstDelayMs !== undefined) return options.firstDelayMs;
  const fromEnv = Number.parseInt(process.env.CORTEX_TELEMETRY_FIRST_DELAY_S ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv * 1000 : DEFAULT_FIRST_DELAY_MS;
}

function onSwitchChanged(changed: string[]): void {
  if (changed.includes('telemetryEnabled') && !isTelemetryActive()) wipeLocalTelemetry();
}

export function startTelemetry(options: TelemetryServiceOptions): void {
  if (running) return;
  running = { options, bootAt: options.now?.() ?? Date.now(), unsubscribe: onSettingsChange(onSwitchChanged) };
  backoff = new UploadBackoff(() => now());
  if (!isTelemetryActive()) return wipeLocalTelemetry();
  scheduleFlush(STARTUP_FLUSH_DELAY_MS);
}

/** Shutdown: persist aggregates; queued events wait for the next boot. */
export function stopTelemetry(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  running?.unsubscribe();
  running = null;
  if (isTelemetryActive()) runHooks((hook) => hook.persist);
}

export function telemetryRunning(): boolean {
  return running !== null;
}
