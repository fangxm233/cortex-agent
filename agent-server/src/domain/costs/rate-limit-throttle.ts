// input:  rate_limit_event + persistence + slack client + optional onResume hook
// output: init/handleRateLimitEvent/isThrottled/isModeRateLimited/getThrottleState
// pos:    Pure state tracker — no scheduler coupling. Mode-level rate limit tracking.
//         onResume (injected) fires when the window clears (timer path + expired-on-restart),
//         decoupling the resume dispatch (orchestration) from this domain module.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { PlatformAdapter } from '@platform/index.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';

const log = createLogger('rate-limit-throttle');

/** Per-type utilization thresholds. Unknown types fall back to DEFAULT_THRESHOLD. */
const TYPE_THRESHOLDS: Record<string, number> = {
  five_hour: 0.90,
  seven_day: 0.95,
  seven_day_overage_included: 0.95,
};
const DEFAULT_THRESHOLD = 0.90;
const RESUME_BUFFER_MS = 5_000;

// --- Module state ---
let _adapter: PlatformAdapter | null = null;
let _persistence: ThrottlePersistence | null = null;
let _onResume: (() => void) | null = null;
let _isThrottled = false;
let _resetsAt: number | null = null; // Unix seconds
let _resumeTimer: ReturnType<typeof setTimeout> | null = null;
const _rateLimitedModes = new Set<string>();
const _rateLimitedTypes = new Set<string>();

// --- Types ---
export interface ThrottlePersistence {
  save: (state: { resetsAt: number; activatedAt: number; modes: string[]; types: string[] } | null) => Promise<void>;
  load: () => Promise<{ resetsAt: number; activatedAt: number; modes?: string[]; types?: string[] } | null>;
}

// --- Logging (handled by createLogger) ---

// --- Admin DM (fire-and-forget) ---
function sendDM(text: string) {
  if (!_adapter) return;
  void emitSystemNotice(_adapter, { text, level: 'warning', title: 'Rate limit' });
}

function formatResetTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatRemaining(epochSec: number): string {
  const totalSec = Math.max(0, Math.round(epochSec - Date.now() / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

// --- Timer ---
function clearThrottle(): void {
  _isThrottled = false;
  _resetsAt = null;
  _rateLimitedModes.clear();
  _rateLimitedTypes.clear();
  _resumeTimer = null;
  sendDM(`${Icons.ok} Rate limit throttle cleared.`);
  _persistence?.save(null).catch(e => {
    log.error(`Failed to persist cleared throttle: ${(e as Error).message}`);
  });
  fireResume();
}

/** Notify the (optional) resume hook that the rate-limit window has ended. Errors are
 *  swallowed so a faulty resume path can never break the throttle state machine. */
function fireResume(): void {
  if (!_onResume) return;
  try {
    _onResume();
  } catch (e) {
    log.error(`onResume hook failed: ${(e as Error).message}`);
  }
}

function scheduleResumeTimer(): void {
  if (_resumeTimer) clearTimeout(_resumeTimer);
  const delayMs = Math.max(0, (_resetsAt! * 1000) - Date.now()) + RESUME_BUFFER_MS;
  log.info(`Resume scheduled in ${(delayMs / 1000 / 60).toFixed(1)} min`);
  _resumeTimer = setTimeout(() => {
    clearThrottle();
  }, delayMs);
}

// --- Public API ---

async function initRateLimitThrottle(adapter: PlatformAdapter, persistence: ThrottlePersistence, onResume?: () => void): Promise<void> {
  _adapter = adapter;
  _persistence = persistence;
  _onResume = onResume ?? null;

  // Recover throttle state from disk (survives restart)
  const persisted = await persistence.load();
  if (persisted) {
    const now = Date.now();
    if (persisted.resetsAt * 1000 + RESUME_BUFFER_MS > now) {
      _isThrottled = true;
      _resetsAt = persisted.resetsAt;
      if (persisted.modes) {
        for (const m of persisted.modes) _rateLimitedModes.add(m);
      }
      if (persisted.types) {
        for (const t of persisted.types) _rateLimitedTypes.add(t);
      }
      log.info(`Restored throttle from disk: ${persisted.modes?.length ?? 0} mode(s), ${persisted.types?.length ?? 0} type(s) rate-limited, resetsAt=${new Date(_resetsAt * 1000).toISOString()}`);
      scheduleResumeTimer();
    } else {
      log.info(`Throttle expired during downtime (resetsAt was ${new Date(persisted.resetsAt * 1000).toISOString()}). Clearing.`);
      await persistence.save(null);
      // The window already reset while the process was down — resume anything that was
      // recorded before the restart.
      fireResume();
    }
  }

  log.info('Initialized');
}

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

function thresholdFor(type: string): number {
  return TYPE_THRESHOLDS[type] ?? DEFAULT_THRESHOLD;
}

async function handleRateLimitEvent(info: RateLimitInfo, mode?: string): Promise<void> {
  if (!info || !_persistence) return;
  const type = info.rateLimitType;
  if (!type) return;
  const threshold = thresholdFor(type);
  if (typeof info.utilization !== 'number' || info.utilization < threshold) return;
  if (!info.resetsAt) return;

  if (_isThrottled) {
    _rateLimitedTypes.add(type);
    if (info.resetsAt > (_resetsAt || 0)) {
      log.info(`Extending throttle (${type}): resetsAt ${_resetsAt} → ${info.resetsAt}`);
      _resetsAt = info.resetsAt;
      if (mode) _rateLimitedModes.add(mode);
      await _persistence.save({ resetsAt: _resetsAt, activatedAt: Date.now(), modes: [..._rateLimitedModes], types: [..._rateLimitedTypes] });
      scheduleResumeTimer();
    }
    return;
  }

  _isThrottled = true;
  _resetsAt = info.resetsAt;
  _rateLimitedTypes.add(type);
  if (mode) _rateLimitedModes.add(mode);
  log.info(`Throttle activated (${type}): utilization=${info.utilization}, resetsAt=${new Date(_resetsAt * 1000).toISOString()}, mode=${mode ?? '(none)'}`);

  scheduleResumeTimer();
  await _persistence.save({ resetsAt: _resetsAt, activatedAt: Date.now(), modes: [..._rateLimitedModes], types: [..._rateLimitedTypes] });

  const resetStr = formatResetTime(_resetsAt);
  const remainingStr = formatRemaining(_resetsAt);
  const typeNote = type ? ` [${type}]` : '';
  const modeNote = mode ? ` (mode: ${mode})` : '';
  sendDM(`${Icons.warning} Rate limit throttle activated${typeNote} — utilization ${(info.utilization * 100).toFixed(0)}%${modeNote}.\nAuto-resume at ${resetStr} (in ${remainingStr}).`);
}

function isThrottled(): boolean {
  return _isThrottled;
}

function isModeRateLimited(mode: string): boolean {
  return _isThrottled && _rateLimitedModes.has(mode);
}

function getThrottleState(): { isThrottled: boolean; resetsAt: number | null; rateLimitedModes: string[]; rateLimitedTypes: string[] } {
  return { isThrottled: _isThrottled, resetsAt: _resetsAt, rateLimitedModes: [..._rateLimitedModes], rateLimitedTypes: [..._rateLimitedTypes] };
}

// --- Test helpers ---
function _testReset(): void {
  if (_resumeTimer) clearTimeout(_resumeTimer);
  _isThrottled = false;
  _resetsAt = null;
  _resumeTimer = null;
  _rateLimitedModes.clear();
  _rateLimitedTypes.clear();
  _adapter = null;
  _persistence = null;
  _onResume = null;
}

export { initRateLimitThrottle, handleRateLimitEvent, isThrottled, isModeRateLimited, getThrottleState, _testReset };
