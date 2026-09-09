// input:  typed native bridge and update payload parsers
// output: single-flight manual checks and result subscriptions
// pos:    Manual update adapter; never installs or owns prompts
// >>> If updated, update this header and parent CORTEX.md <<<

import { isNativeCommandMissing, safeInvoke } from '@/lib/native-bridge';
import { parseAppUpdate, type AppUpdateInfo } from '@/features/app-update/app-update';
import { parseStagedUpdate, type StagedUpdate } from '@/features/hot-update/frontend-update';

export interface ChannelOutcome<T> {
  status: 'available' | 'current' | 'skipped' | 'error';
  update?: T;
  reason?: string;
}

/** Mirrors update_checks.rs, including nullable fields in serialized native payloads. */
export interface NativeCheckReport {
  ui: ChannelOutcome<{ version: string; fromVersion: string | null; size: number }>;
  shell: ChannelOutcome<{
    version: string; releaseUrl: string | null; notes: string | null; size: number; kind: string;
  }>;
}

export interface UpdateCheckReport {
  ui: ChannelOutcome<StagedUpdate>;
  shell: ChannelOutcome<AppUpdateInfo>;
}

type ResultListener = (report: UpdateCheckReport) => void;
const listeners = new Set<() => void>();
const resultListeners = new Set<ResultListener>();
let inFlight: Promise<UpdateCheckReport> | null = null;

export const getManualCheckBusy = () => inFlight !== null;
export function subscribeManualCheck(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function subscribeManualCheckResult(listener: ResultListener): () => void {
  resultListeners.add(listener);
  return () => { resultListeners.delete(listener); };
}

function failedReport(reason: string): UpdateCheckReport {
  return { ui: { status: 'error', reason }, shell: { status: 'error', reason } };
}

function channelShape(value: unknown): ChannelOutcome<unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const channel = value as ChannelOutcome<unknown>;
  if (!['available', 'current', 'skipped', 'error'].includes(channel.status)) return null;
  if (channel.reason !== undefined && typeof channel.reason !== 'string') return null;
  return channel;
}

function parseChannel<T>(value: unknown, parse: (payload: unknown) => T | null): ChannelOutcome<T> | null {
  const channel = channelShape(value);
  if (!channel) return null;
  const update = channel.update === undefined ? undefined : parse(channel.update);
  if (update === null || (channel.status === 'available' && !update)) return null;
  if (channel.status === 'current' && update) return null;
  return { status: channel.status, ...(update ? { update } : {}),
    ...(channel.reason !== undefined ? { reason: channel.reason } : {}) };
}

async function requestReport(): Promise<UpdateCheckReport> {
  const result = await safeInvoke('check_for_updates');
  if (isNativeCommandMissing(result)) return failedReport('unsupported_shell');
  if (!result.ok) return failedReport('check_failed');
  const ui = parseChannel(result.value?.ui, parseStagedUpdate);
  const shell = parseChannel(result.value?.shell, parseAppUpdate);
  return ui && shell ? { ui, shell } : failedReport('invalid_report');
}

/** One command across all menu consumers. Events may arrive before this report: the
 * existing prompt owner stays hidden until both channels have been reconciled. */
export function checkForUpdates(): Promise<UpdateCheckReport> {
  if (inFlight) return inFlight;
  inFlight = requestReport().then((report) => {
    // Re-open even previously dismissed prepared updates through the existing sources.
    for (const listener of resultListeners) listener(report);
    return report;
  }).finally(() => {
    inFlight = null;
    for (const listener of listeners) listener();
  });
  for (const listener of listeners) listener();
  return inFlight;
}
