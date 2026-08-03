// input:  provider state, persistence, timer generations
// output: committed throttle gates, clear callbacks, and manual early-release
// pos:    Provider-scoped limit and outage state machine
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { PlatformAdapter, ActionElement } from '@platform/index.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { Icons } from '../../core/icons.js';

const log = createLogger('rate-limit-throttle');

/** Interactive action id used on rate-limit notices ("Resume now" button). Handlers are
 *  registered by the composition root via adapter.onAction; the button value carries the
 *  provider key (empty = all providers). */
export const RATE_LIMIT_CLEAR_ACTION_ID = 'rate-limit:clear';

const TYPE_THRESHOLDS: Record<string, number> = {
  five_hour: 0.90,
  seven_day: 0.95,
  seven_day_overage_included: 0.95,
};
const DEFAULT_THRESHOLD = 0.90;
const RESUME_BUFFER_MS = 5_000;
const EXPIRY_RETRY_DELAY_MS = 5_000;
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

export interface ClearedThrottleProvider {
  provider: string;
  displayName: string;
  /** Window types cleared (e.g. five_hour / outage). */
  types: string[];
  /** Latest resetsAt among the cleared windows (epoch sec) — how long was remaining. */
  resetsAt: number;
}

export interface ClearThrottleResult {
  cleared: ClearedThrottleProvider[];
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
let _resumeTimerGeneration = 0;
const _providers = new Map<string, ProviderThrottleState>();
const _mutationMutex = new AsyncMutex();

function cloneProvider(provider: ProviderThrottleState): ProviderThrottleState {
  return {
    ...provider,
    modes: [...provider.modes].sort(),
    windows: provider.windows.map((window) => ({ ...window })).sort((a, b) => a.resetsAt - b.resetsAt),
  };
}

function snapshot(
  providers: ReadonlyMap<string, ProviderThrottleState> = _providers,
): ProviderThrottleState[] {
  return [...providers.values()].map(cloneProvider).sort((a, b) => a.provider.localeCompare(b.provider));
}

function cloneProviders(): Map<string, ProviderThrottleState> {
  return new Map(snapshot().map((provider) => [provider.provider, provider]));
}

function publishProviders(providers: ReadonlyMap<string, ProviderThrottleState>): void {
  _providers.clear();
  for (const provider of providers.values()) _providers.set(provider.provider, provider);
}

function allWindows(providers: ReadonlyMap<string, ProviderThrottleState> = _providers): RateLimitWindowState[] {
  return snapshot(providers).flatMap((provider) => provider.windows);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function persistableState(
  providers: ReadonlyMap<string, ProviderThrottleState> = _providers,
): RateLimitThrottleState | null {
  const providerSnapshot = snapshot(providers);
  return providerSnapshot.length > 0 ? { providers: providerSnapshot } : null;
}

async function persist(providers: ReadonlyMap<string, ProviderThrottleState> = _providers): Promise<void> {
  await _persistence?.save(persistableState(providers));
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

function sendDM(text: string, title = 'Rate limit', actions?: ActionElement[]): void {
  if (!_adapter) return;
  void emitSystemNotice(_adapter, {
    text,
    level: 'warning',
    title,
    ...(actions && actions.length > 0 ? { actions } : {}),
  });
}

function clearAction(provider: string): ActionElement[] {
  return [{ type: 'button', text: 'Resume now', actionId: RATE_LIMIT_CLEAR_ACTION_ID, value: provider, style: 'primary' }];
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

function cancelResumeTimer(): void {
  if (_resumeTimer) clearTimeout(_resumeTimer);
  _resumeTimer = null;
  _resumeTimerGeneration++;
}

function scheduleResumeTimer(minDelayMs = 0): void {
  cancelResumeTimer();
  const expiry = nextExpiryMs();
  if (expiry === null) return;
  const generation = _resumeTimerGeneration;
  const delayMs = Math.max(minDelayMs, expiry - Date.now(), 0);
  log.info(`Next provider reset check in ${(delayMs / 1000 / 60).toFixed(1)} min`);
  _resumeTimer = setTimeout(() => { void expireWindows(expiry, generation); }, delayMs);
}

interface ClearedProvider {
  provider: string;
  displayName: string;
  expiredTypes: string[];
}

function pruneExpired(
  providers: Map<string, ProviderThrottleState>,
  now: number,
): ClearedProvider[] {
  const cleared: ClearedProvider[] = [];
  for (const [key, provider] of providers) {
    const expiredTypes = provider.windows
      .filter((window) => !windowIsActive(window, now))
      .map((window) => window.type);
    provider.windows = provider.windows.filter((window) => windowIsActive(window, now));
    if (provider.windows.length > 0) continue;
    providers.delete(key);
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

async function persistExpiry(candidate: Map<string, ProviderThrottleState>): Promise<boolean> {
  try {
    await persist(candidate);
    return true;
  } catch (error) {
    log.error(`Failed to persist throttle expiry: ${(error as Error).message}`);
    scheduleResumeTimer(EXPIRY_RETRY_DELAY_MS);
    return false;
  }
}

async function expireWindowsLocked(scheduledExpiry: number): Promise<void> {
  const candidate = cloneProviders();
  const before = allWindows(candidate).length;
  const effectiveNow = Math.max(Date.now(), scheduledExpiry);
  const cleared = pruneExpired(candidate, effectiveNow);
  if (allWindows(candidate).length === before) { scheduleResumeTimer(); return; }
  if (!await persistExpiry(candidate)) return;
  publishProviders(candidate);
  for (const provider of cleared) {
    const notice = clearedNotice(provider);
    sendDM(notice.text, notice.title);
  }
  fireChange();
  if (cleared.length > 0) fireResume(cleared.map((provider) => provider.provider));
  scheduleResumeTimer();
}

async function expireWindows(scheduledExpiry: number, generation: number): Promise<void> {
  await _mutationMutex.run(async () => {
    if (generation !== _resumeTimerGeneration) return;
    _resumeTimer = null;
    await expireWindowsLocked(scheduledExpiry);
  });
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

async function activateOutageWindowLocked(provider: string | null, durationMs: number): Promise<void> {
  if (!_persistence) return;
  const source = normalizeSource(provider ?? undefined);
  const candidate = cloneProviders();
  const current = candidate.get(source.provider);
  const state = current ?? { provider: source.provider, displayName: source.displayName, modes: [], windows: [] };
  if (!current) candidate.set(source.provider, state);
  const changed = upsertWindow(state, {
    rateLimitType: OUTAGE_WINDOW_TYPE,
    utilization: null,
    resetsAt: (Date.now() + durationMs) / 1000,
  });
  if (!changed) return;

  await persist(candidate);
  publishProviders(candidate);
  scheduleResumeTimer();
  fireChange();
  const reset = state.windows.find((window) => window.type === OUTAGE_WINDOW_TYPE)!.resetsAt;
  log.info(`Provider outage activated: provider=${source.provider}, durationMs=${durationMs}`);
  sendDM(`${Icons.warning} ${source.displayName} provider outage detected.
Automated work will retry at ${formatResetTime(reset)} (in ${formatRemaining(reset)}).`, 'Provider outage', clearAction(source.provider));
}

async function activateOutageWindow(provider: string | null, durationMs: number): Promise<void> {
  await _mutationMutex.run(() => activateOutageWindowLocked(provider, durationMs));
}

async function handleRateLimitEventLocked(info: RateLimitInfo, rawSource?: string | RateLimitSource): Promise<void> {
  if (!info || !_persistence || !info.rateLimitType || !info.resetsAt) return;
  if (typeof info.utilization !== 'number' || info.utilization < thresholdFor(info.rateLimitType)) return;
  const source = normalizeSource(rawSource);
  const candidate = cloneProviders();
  let provider = candidate.get(source.provider);
  const isNewProvider = !provider;
  if (!provider) {
    provider = { provider: source.provider, displayName: source.displayName, modes: [], windows: [] };
    candidate.set(source.provider, provider);
  }
  const modeAdded = !!source.mode && !provider.modes.includes(source.mode);
  if (modeAdded) provider.modes.push(source.mode!);
  const windowChanged = upsertWindow(provider, {
    rateLimitType: info.rateLimitType,
    utilization: info.utilization,
    resetsAt: info.resetsAt,
  });
  if (!isNewProvider && !modeAdded && !windowChanged) return;

  await persist(candidate);
  publishProviders(candidate);
  scheduleResumeTimer();
  fireChange();
  log.info(`Throttle updated: provider=${source.provider}, type=${info.rateLimitType}, utilization=${info.utilization}, mode=${source.mode ?? '(none)'}`);
  if (isNewProvider) {
    sendDM(`${Icons.warning} ${source.displayName} rate limit throttle activated [${info.rateLimitType}] — utilization ${(info.utilization * 100).toFixed(0)}%.
Auto-resume at ${formatResetTime(info.resetsAt)} (in ${formatRemaining(info.resetsAt)}).`, 'Rate limit', clearAction(source.provider));
  }
}

async function handleRateLimitEvent(info: RateLimitInfo, rawSource?: string | RateLimitSource): Promise<void> {
  await _mutationMutex.run(() => handleRateLimitEventLocked(info, rawSource));
}

async function clearThrottleLocked(provider?: string | null): Promise<ClearThrottleResult> {
  if (!_persistence) return { cleared: [] };
  const candidate = cloneProviders();
  const targets = provider
    ? (candidate.has(provider) ? [provider] : [])
    : [...candidate.keys()];
  if (targets.length === 0) return { cleared: [] };

  const cleared: ClearedThrottleProvider[] = [];
  for (const key of targets) {
    const state = candidate.get(key)!;
    const resetsAt = state.windows.reduce((max, w) => Math.max(max, w.resetsAt), 0);
    cleared.push({
      provider: key,
      displayName: state.displayName,
      types: state.windows.map((w) => w.type),
      resetsAt,
    });
    candidate.delete(key);
  }

  await persist(candidate);
  publishProviders(candidate);
  scheduleResumeTimer();
  fireChange();
  fireResume(cleared.map((c) => c.provider));
  for (const item of cleared) {
    const names = item.types.join(', ');
    log.info(`Throttle manually cleared: provider=${item.provider}, types=${names}`);
    sendDM(`${Icons.ok} ${item.displayName} rate limit throttle cleared manually — paused work is resuming now.
If the provider is still rate-limited, the next request will re-activate the throttle automatically.`);
  }
  return { cleared };
}

/** Manually lift an active rate-limit (or outage) throttle early, for one provider or all.
 *  Walks the same recovery path as a natural window expiry: persists the cleared state,
 *  re-schedules the resume timer, notifies the UI, and fires onResume so paused work is
 *  dispatched immediately. Idempotent — no active window yields an empty result and no notices.
 *  If the provider is actually still rate-limited, the next API call's rate-limit event
 *  re-activates the throttle automatically. */
async function clearThrottle(provider?: string | null): Promise<ClearThrottleResult> {
  return _mutationMutex.run(() => clearThrottleLocked(provider));
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
  cancelResumeTimer();
  _providers.clear();
  _adapter = null;
  _persistence = null;
  _onResume = null;
  _onChange = null;
}

export {
  initRateLimitThrottle,
  activateOutageWindow,
  handleRateLimitEvent,
  clearThrottle,
  isThrottled,
  isProviderRateLimited,
  isProviderUsageRateLimited,
  isProviderModeRateLimited,
  isModeRateLimited,
  getThrottleState,
  _testReset,
};
