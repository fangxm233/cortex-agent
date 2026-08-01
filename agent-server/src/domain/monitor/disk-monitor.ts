// input:  PlatformAdapter, settings, DATA_DIR, fs.statfs
// output: init/stop/checkDiskOnce + alert helpers
// pos:    Cortex data filesystem capacity alert monitoring
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { promises as fsp } from 'fs';
import type { PlatformAdapter } from '@platform/index.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { createLogger } from '@core/log.js';
import { DATA_DIR } from '@core/paths.js';
import { getSettings, onSettingsChange } from '@core/settings.js';
import { Icons } from '../../core/icons.js';

const log = createLogger('disk-monitor');

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WARN_BYTES = 500 * 1024 * 1024;
const HYSTERESIS_BYTES = 1024 * 1024 * 1024;
const REALERT_COOLDOWN_MS = 60 * 60 * 1000;
const WATCH_PATH = DATA_DIR;

interface AlertState {
  hasAlerted: boolean;
  lastAlertAt: number | null;
}

interface AlertDecision {
  alert: boolean;
  newState: AlertState;
}

let _adapter: PlatformAdapter | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
let _unsubscribeSettings: (() => void) | null = null;
let _intervalMs = DEFAULT_CHECK_INTERVAL_MS;
let _state: AlertState = { hasAlerted: false, lastAlertAt: null };


function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function shouldAlert(freeBytes: number, state: AlertState, now: number): AlertDecision {
  if (freeBytes >= HYSTERESIS_BYTES) {
    return { alert: false, newState: { hasAlerted: false, lastAlertAt: null } };
  }
  if (freeBytes < WARN_BYTES) {
    if (!state.hasAlerted) {
      return { alert: true, newState: { hasAlerted: true, lastAlertAt: now } };
    }
    const elapsed = now - (state.lastAlertAt ?? 0);
    if (elapsed >= REALERT_COOLDOWN_MS) {
      return { alert: true, newState: { hasAlerted: true, lastAlertAt: now } };
    }
  }
  return { alert: false, newState: state };
}

async function getFreeBytes(path: string): Promise<number> {
  const stat = await fsp.statfs(path);
  return Number(stat.bsize) * Number(stat.bavail);
}

function sendDM(text: string): void {
  if (!_adapter) return;
  void emitSystemNotice(_adapter, { text, level: 'warning', title: 'Disk' });
}

async function checkDiskOnce(): Promise<void> {
  if (!getSettings().diskMonitor) return;
  let freeBytes: number;
  try {
    freeBytes = await getFreeBytes(WATCH_PATH);
  } catch (e) {
    log.error(`statfs(${WATCH_PATH}) failed: ${(e as Error).message}`);
    return;
  }
  if (!getSettings().diskMonitor) return;

  const decision = shouldAlert(freeBytes, _state, Date.now());
  _state = decision.newState;

  if (decision.alert) {
    const msg = `${Icons.warning} Disk low on \`${WATCH_PATH}\`: only *${formatBytes(freeBytes)}* free (< ${formatBytes(WARN_BYTES)} threshold). Clean up or Cortex may crash.`;
    log.info(`ALERT: free=${formatBytes(freeBytes)}`);
    sendDM(msg);
  }
}

function stopTimer(): void {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
}

function startTimer(): void {
  if (_timer) return;
  _timer = setInterval(() => {
    checkDiskOnce().catch(e => log.error(`check failed: ${(e as Error).message}`));
  }, _intervalMs);
  checkDiskOnce().catch(e => log.error(`initial check failed: ${(e as Error).message}`));
}

function syncMonitorState(): void {
  if (!getSettings().diskMonitor) {
    stopTimer();
    _state = { hasAlerted: false, lastAlertAt: null };
    return;
  }
  startTimer();
}

function initDiskMonitor(adapter: PlatformAdapter, intervalMs: number = DEFAULT_CHECK_INTERVAL_MS): void {
  if (_adapter) {
    log.info('Already initialized, skipping');
    return;
  }
  _adapter = adapter;
  _intervalMs = intervalMs;
  _unsubscribeSettings = onSettingsChange((changedKeys) => {
    if (changedKeys.includes('diskMonitor')) syncMonitorState();
  });
  syncMonitorState();
  log.info(`Initialized (path=${WATCH_PATH}, enabled=${getSettings().diskMonitor}, interval=${Math.round(intervalMs / 1000)}s, warn<${formatBytes(WARN_BYTES)}, recover>=${formatBytes(HYSTERESIS_BYTES)})`);
}

function stopDiskMonitor(): void {
  stopTimer();
  _unsubscribeSettings?.();
  _unsubscribeSettings = null;
  _adapter = null;
  _intervalMs = DEFAULT_CHECK_INTERVAL_MS;
  _state = { hasAlerted: false, lastAlertAt: null };
}

function _testReset(): void {
  stopDiskMonitor();
}

export {
  initDiskMonitor, stopDiskMonitor, checkDiskOnce, shouldAlert, formatBytes,
  WARN_BYTES, HYSTERESIS_BYTES, REALERT_COOLDOWN_MS,
  _testReset,
};
export type { AlertState, AlertDecision };
