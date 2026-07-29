// input:  provider windows, persistence, platform adapter
// output: throttle state, automated gates, clear callbacks
// pos:    Provider-scoped limit and outage state machine
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { PlatformAdapter } from '@platform/index.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { Icons } from '../../core/icons.js';

const log = createLogger('rate-limit-throttle');

const TYPE_THRESHOLDS: Record<string, number> = {
  five_hour: 0.90,
  seven_day: 0.95,
  seven_day_overage_included: 0.95,
};
const DEFAULT_THRESHOLD = 0.90;
const RESUME_BUFFER_MS = 5_000;
const OUTAGE_WINDOW_TYPE = 'outage';

export interface RateLimitSource {
  provider: string;
  displayName: string;
  mode?: string;
}

export interface RateLimitWindowState {
  type: string;
  utilization: number | null;
  resetsAt: number;
  activatedAt: number;
}

export interface ProviderThrottleState {
  provider: string;
  displayName: string;
  modes: string[];
  windows: RateLimitWindowState[];
}

export interface RateLimitThrottleState {
  providers: ProviderThrottleState[];
}

export interface LegacyThrottleState {
  resetsAt: number;
  activatedAt: number;
  modes?: string[];
  types?: string[];
}

export type PersistedThrottleState = RateLimitThrottleState | LegacyThrottleState;

export interface ThrottlePersistence {
  save: (state: RateLimitThrottleState | null) => Promise<void>;
  load: () => Promise<PersistedThrottleState | null>;
}

export interface ThrottleStateView extends RateLimitThrottleState {
  isThrottled: boolean;
  resetsAt: number | null;
  rateLimitedModes: string[];
  rateLimitedTypes: string[];
}

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

let _adapter: PlatformAdapter | null = null;
let _persistence: ThrottlePersistence | null = null;
let _onResume: ((providers: string[]) => void) | null = null;
let _onChange: (() => void) | null = null;
let _resumeTimer: ReturnType<typeof setTimeout> | null = null;
const _providers = new Map<string, ProviderThrottleState>();
const _mutationMutex = new AsyncMutex();

function cloneProvider(provider: ProviderThrottleState): ProviderThrottleState {
  return {
    ...provider,
    modes: [...provider.modes].sort(),
    windows: provider.windows.map((window) => ({ ...window })).sort((a, b) => a.resetsAt - b.resetsAt),
  };
}

function snapshot(): ProviderThrottleState[] {
  return [..._providers.values()].map(cloneProvider).sort((a, b) => a.provider.localeCompare(b.provider));
}

function allWindows(): RateLimitWindowState[] {
  return snapshot().flatMap((provider) => provider.windows);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function persistableState(): RateLimitThrottleState | null {
  const providers = snapshot();
  return providers.length > 0 ? { providers } : null;
}

async function persist(): Promise<void> {
  await _persistence?.save(persistableState());
}

function fireChange(): void {
  try { _onChange?.(); } catch (error) {
    log.error(`onChange hook failed: ${(error as Error).message}`);
  }
}

function fireResume(providers: string[]): void {
  try { _onResume?.(providers); } catch (error) {
    log.error(`onResume hook failed: ${(error as Error).message}`);
  }
}

function sendDM(text: string, title = 'Rate limit'): void {
  if (!_adapter) return;
  void emitSystemNotice(_adapter, { text, level: 'warning', title });
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

function thresholdFor(type: string): number {
  return TYPE_THRESHOLDS[type] ?? DEFAULT_THRESHOLD;
}

function normalizeSource(source?: string | RateLimitSource): RateLimitSource {
  if (typeof source === 'string') return { provider: source, displayName: source, mode: source };
  if (source?.provider) return source;
  return { provider: 'unknown', displayName: 'Unknown provider' };
}

function normalizeProvider(raw: ProviderThrottleState): ProviderThrottleState | null {
  if (!raw?.provider || !Array.isArray(raw.windows)) return null;
  const windows = raw.windows.filter((window) => window?.type && Number.isFinite(window.resetsAt));
  if (windows.length === 0) return null;
  return {
    provider: raw.provider,
    displayName: raw.displayName || raw.provider,
    modes: Array.isArray(raw.modes) ? uniqueSorted(raw.modes.filter(Boolean)) : [],
    windows: windows.map((window) => ({
      type: window.type,
      utilization: Number.isFinite(window.utilization) ? window.utilization : null,
      resetsAt: window.resetsAt,
      activatedAt: Number.isFinite(window.activatedAt) ? window.activatedAt : Date.now(),
    })),
  };
}

function fromLegacy(raw: LegacyThrottleState): ProviderThrottleState[] {
  if (!Number.isFinite(raw.resetsAt)) return [];
  const types = raw.types?.length ? raw.types : ['unknown'];
  return [{
    provider: 'anthropic',
    displayName: 'Anthropic',
    modes: uniqueSorted(raw.modes ?? []),
    windows: types.map((type) => ({
      type,
      utilization: null,
      resetsAt: raw.resetsAt,
      activatedAt: raw.activatedAt,
    })),
  }];
}

function normalizePersisted(raw: PersistedThrottleState): ProviderThrottleState[] {
  const providerState = raw as RateLimitThrottleState;
  if (Array.isArray(providerState.providers)) {
    return providerState.providers.map(normalizeProvider).filter((provider): provider is ProviderThrottleState => provider !== null);
  }
  return fromLegacy(raw as LegacyThrottleState);
}

function windowExpiryMs(window: RateLimitWindowState): number {
  const buffer = window.type === OUTAGE_WINDOW_TYPE ? 0 : RESUME_BUFFER_MS;
  return window.resetsAt * 1000 + buffer;
}

function windowIsActive(window: RateLimitWindowState, now = Date.now()): boolean {
  return windowExpiryMs(window) > now;
}

function loadActiveProviders(raw: PersistedThrottleState): void {
  for (const provider of normalizePersisted(raw)) {
    const windows = provider.windows.filter((window) => windowIsActive(window));
    if (windows.length > 0) _providers.set(provider.provider, { ...provider, windows });
  }
}

function nextExpiryMs(): number | null {
  const resets = allWindows().map(windowExpiryMs);
  return resets.length > 0 ? Math.min(...resets) : null;
}

function scheduleResumeTimer(): void {
  if (_resumeTimer) clearTimeout(_resumeTimer);
  const expiry = nextExpiryMs();
  if (expiry === null) { _resumeTimer = null; return; }
  const delayMs = Math.max(0, expiry - Date.now());
  log.info(`Next provider reset check in ${(delayMs / 1000 / 60).toFixed(1)} min`);
  _resumeTimer = setTimeout(() => { void expireWindows(expiry); }, delayMs);
}

interface ClearedProvider {
  provider: string;
  displayName: string;
  expiredTypes: string[];
}

function pruneExpired(now: number): ClearedProvider[] {
  const cleared: ClearedProvider[] = [];
  for (const [key, provider] of _providers) {
    const expiredTypes = provider.windows
      .filter((window) => !windowIsActive(window, now))
      .map((window) => window.type);
    provider.windows = provider.windows.filter((window) => windowIsActive(window, now));
    if (provider.windows.length > 0) continue;
    _providers.delete(key);
    cleared.push({ provider: key, displayName: provider.displayName, expiredTypes });
  }
  return cleared;
}

function clearedNotice(provider: ClearedProvider): { text: string; title?: string } {
  if (provider.expiredTypes.includes(OUTAGE_WINDOW_TYPE)) {
    return {
      text: `${Icons.ok} ${provider.displayName} provider outage window cleared.`,
      title: 'Provider outage',
    };
  }
  return { text: `${Icons.ok} ${provider.displayName} rate limit throttle cleared.` };
}

async function expireWindowsLocked(scheduledExpiry?: number): Promise<void> {
  _resumeTimer = null;
  const before = allWindows().length;
  const effectiveNow = Math.max(Date.now(), scheduledExpiry ?? 0);
  const cleared = pruneExpired(effectiveNow);
  if (allWindows().length === before) { scheduleResumeTimer(); return; }
  await persist().catch((error) => log.error(`Failed to persist throttle expiry: ${(error as Error).message}`));
  for (const provider of cleared) {
    const notice = clearedNotice(provider);
    sendDM(notice.text, notice.title);
  }
  fireChange();
  if (cleared.length > 0) fireResume(cleared.map((provider) => provider.provider));
  scheduleResumeTimer();
}

async function expireWindows(scheduledExpiry?: number): Promise<void> {
  await _mutationMutex.run(() => expireWindowsLocked(scheduledExpiry));
}

async function initRateLimitThrottle(
  adapter: PlatformAdapter,
  persistence: ThrottlePersistence,
  onResume?: (providers: string[]) => void,
  onChange?: () => void,
): Promise<void> {
  _adapter = adapter;
  _persistence = persistence;
  _onResume = onResume ?? null;
  _onChange = onChange ?? null;
  const persisted = await persistence.load();
  if (!persisted) { log.info('Initialized'); return; }

  loadActiveProviders(persisted);
  if (_providers.size === 0) {
    await persistence.save(null);
    fireResume([]);
  } else {
    await persist();
    scheduleResumeTimer();
  }
  log.info(`Initialized — ${_providers.size} provider throttle(s) restored`);
}

interface WindowUpdate {
  rateLimitType: string;
  utilization: number | null;
  resetsAt: number;
}

function upsertWindow(provider: ProviderThrottleState, info: WindowUpdate): boolean {
  const existing = provider.windows.find((window) => window.type === info.rateLimitType);
  if (!existing) {
    provider.windows.push({
      type: info.rateLimitType,
      utilization: info.utilization,
      resetsAt: info.resetsAt,
      activatedAt: Date.now(),
    });
    return true;
  }
  const nextReset = Math.max(existing.resetsAt, info.resetsAt);
  const nextUtilization = info.utilization;
  const changed = nextReset !== existing.resetsAt || nextUtilization !== existing.utilization;
  existing.resetsAt = nextReset;
  existing.utilization = nextUtilization;
  return changed;
}

function restoreProviderState(provider: string, previous: ProviderThrottleState | null): void {
  if (previous) _providers.set(provider, previous);
  else _providers.delete(provider);
  scheduleResumeTimer();
}

async function persistOutageOrRollback(
  provider: string,
  previous: ProviderThrottleState | null,
): Promise<void> {
  try {
    await persist();
  } catch (error) {
    restoreProviderState(provider, previous);
    throw error;
  }
}

async function activateOutageWindowLocked(provider: string | null, durationMs: number): Promise<void> {
  if (!_persistence) return;
  const source = normalizeSource(provider ?? undefined);
  const current = _providers.get(source.provider);
  const previous = current ? cloneProvider(current) : null;
  const state = current ?? { provider: source.provider, displayName: source.displayName, modes: [], windows: [] };
  if (!current) _providers.set(source.provider, state);
  const changed = upsertWindow(state, {
    rateLimitType: OUTAGE_WINDOW_TYPE,
    utilization: null,
    resetsAt: (Date.now() + durationMs) / 1000,
  });
  if (!changed) return;

  await persistOutageOrRollback(source.provider, previous);
  scheduleResumeTimer();
  fireChange();
  const reset = state.windows.find((window) => window.type === OUTAGE_WINDOW_TYPE)!.resetsAt;
  log.info(`Provider outage activated: provider=${source.provider}, durationMs=${durationMs}`);
  sendDM(`${Icons.warning} ${source.displayName} provider outage detected.
Automated work will retry at ${formatResetTime(reset)} (in ${formatRemaining(reset)}).`, 'Provider outage');
}

async function activateOutageWindow(provider: string | null, durationMs: number): Promise<void> {
  await _mutationMutex.run(() => activateOutageWindowLocked(provider, durationMs));
}

async function handleRateLimitEventLocked(info: RateLimitInfo, rawSource?: string | RateLimitSource): Promise<void> {
  if (!info || !_persistence || !info.rateLimitType || !info.resetsAt) return;
  if (typeof info.utilization !== 'number' || info.utilization < thresholdFor(info.rateLimitType)) return;

  const source = normalizeSource(rawSource);
  let provider = _providers.get(source.provider);
  const isNewProvider = !provider;
  if (!provider) {
    provider = { provider: source.provider, displayName: source.displayName, modes: [], windows: [] };
    _providers.set(source.provider, provider);
  }
  const modeAdded = !!source.mode && !provider.modes.includes(source.mode);
  if (modeAdded) provider.modes.push(source.mode!);
  const windowChanged = upsertWindow(provider, {
    rateLimitType: info.rateLimitType,
    utilization: info.utilization,
    resetsAt: info.resetsAt,
  });
  if (!isNewProvider && !modeAdded && !windowChanged) return;

  await persist();
  scheduleResumeTimer();
  fireChange();
  log.info(`Throttle updated: provider=${source.provider}, type=${info.rateLimitType}, utilization=${info.utilization}, mode=${source.mode ?? '(none)'}`);
  if (isNewProvider) {
    sendDM(`${Icons.warning} ${source.displayName} rate limit throttle activated [${info.rateLimitType}] — utilization ${(info.utilization * 100).toFixed(0)}%.
Auto-resume at ${formatResetTime(info.resetsAt)} (in ${formatRemaining(info.resetsAt)}).`);
  }
}

async function handleRateLimitEvent(info: RateLimitInfo, rawSource?: string | RateLimitSource): Promise<void> {
  await _mutationMutex.run(() => handleRateLimitEventLocked(info, rawSource));
}

function isThrottled(): boolean {
  return _providers.size > 0;
}

function isProviderRateLimited(provider: string | null | undefined): boolean {
  if (!provider) return _providers.size > 0;
  return _providers.has(provider);
}

function isProviderUsageRateLimited(provider: string | null | undefined): boolean {
  const states = provider ? [_providers.get(provider)] : [..._providers.values()];
  return states.some((state) => state?.windows.some((window) => window.type !== OUTAGE_WINDOW_TYPE));
}

function isProviderModeRateLimited(provider: string, mode: string): boolean {
  const state = _providers.get(provider);
  if (!state) return false;
  return state.windows.some((window) => window.type === OUTAGE_WINDOW_TYPE)
    || state.modes.includes(mode);
}

function isModeRateLimited(mode: string): boolean {
  return snapshot().some((provider) => provider.modes.includes(mode));
}

function getThrottleState(): ThrottleStateView {
  const providers = snapshot();
  const windows = providers.flatMap((provider) => provider.windows);
  const resetsAt = windows.length > 0 ? Math.max(...windows.map((window) => window.resetsAt)) : null;
  return {
    isThrottled: providers.length > 0,
    resetsAt,
    rateLimitedModes: uniqueSorted(providers.flatMap((provider) => provider.modes)),
    rateLimitedTypes: uniqueSorted(windows.map((window) => window.type)),
    providers,
  };
}

function _testReset(): void {
  if (_resumeTimer) clearTimeout(_resumeTimer);
  _providers.clear();
  _resumeTimer = null;
  _adapter = null;
  _persistence = null;
  _onResume = null;
  _onChange = null;
}

export {
  initRateLimitThrottle,
  activateOutageWindow,
  handleRateLimitEvent,
  isThrottled,
  isProviderRateLimited,
  isProviderUsageRateLimited,
  isProviderModeRateLimited,
  isModeRateLimited,
  getThrottleState,
  _testReset,
};
