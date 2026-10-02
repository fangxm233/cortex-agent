import type { SystemUpdateCheckResult } from '@cortex-agent/ui-contract';
import { isNativeShell } from '@/lib/desktop-config';
import { isNativeCommandMissing, safeInvoke, type ChannelOutcome } from '@/lib/native-bridge';
import { checkBrowserUpdate, type BrowserPageUpdate } from '@/features/hot-update/browser-update';
import { publishManualCheckResult, type ManualCheckReport } from '@/lib/manual-update-check-result';
import { parseAppUpdate, type AppUpdateInfo } from '@/features/app-update/app-update';
import { parseStagedUpdate, type StagedUpdate } from '@/features/hot-update/frontend-update';

export type UpdateCheckReport = ManualCheckReport<StagedUpdate | BrowserPageUpdate, AppUpdateInfo>;

const listeners = new Set<() => void>();
let inFlight: Promise<UpdateCheckReport> | null = null;

export const getManualCheckBusy = () => inFlight !== null;
export function subscribeManualCheck(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
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

async function requestNativeReport(): Promise<UpdateCheckReport> {
  const result = await safeInvoke('check_for_updates');
  if (isNativeCommandMissing(result)) return failedReport('unsupported_shell');
  if (!result.ok) return failedReport('check_failed');
  const ui = parseChannel(result.value?.ui, parseStagedUpdate);
  const shell = parseChannel(result.value?.shell, parseAppUpdate);
  return ui && shell ? { ui, shell } : failedReport('invalid_report');
}

async function requestFrontendReport(): Promise<UpdateCheckReport> {
  return isNativeShell() ? requestNativeReport() : { ui: await checkBrowserUpdate() };
}

async function requestServer(check: () => Promise<SystemUpdateCheckResult>): Promise<SystemUpdateCheckResult> {
  try { return await check(); }
  catch { return { status: 'error', reason: 'check_failed' }; }
}

/** The provider injects its authenticated mutation; no client or credentials are stored globally. */
export function checkForUpdates(checkServer: () => Promise<SystemUpdateCheckResult>): Promise<UpdateCheckReport> {
  return runCheck(async () => {
    const server = await requestServer(checkServer);
    return { server, ...await requestFrontendReport() };
  });
}

/** Reconnection never re-enters server discovery. Queue a fresh frontend pass if a manual check
 * was already running against the old server version. */
export function checkFrontendUpdates(): Promise<UpdateCheckReport> {
  if (inFlight) return inFlight.then(() => checkFrontendUpdates());
  return runCheck(requestFrontendReport);
}

/** One check across menu consumers. Early native events stay gated until reports reconcile. */
function runCheck(request: () => Promise<UpdateCheckReport>): Promise<UpdateCheckReport> {
  if (inFlight) return inFlight;
  inFlight = request().then((report) => {
    // Re-open even previously dismissed prepared updates through the existing sources. The channels
    // hear this through @/lib/manual-update-check-result, so none of them imports this module.
    publishManualCheckResult(report);
    return report;
  }).finally(() => {
    inFlight = null;
    for (const listener of listeners) listener();
  });
  for (const listener of listeners) listener();
  return inFlight;
}
