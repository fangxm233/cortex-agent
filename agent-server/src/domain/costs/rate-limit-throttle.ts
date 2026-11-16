import type { PlatformAdapter, ActionElement } from '@platform/index.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { getSettings } from '@core/settings.js';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { Icons } from '../../core/icons.js';
import { t, getLocale } from '@core/i18n.js';
import { SUBSCRIPTION_CONNECTION } from '@core/connections-file.js';
import { parseThrottleKey, throttleKey } from './throttle-key.js';

const log = createLogger('rate-limit-throttle');

/** Interactive action id used on rate-limit notices ("Resume now" button). Handlers are
 *  registered by the composition root via adapter.onAction; the button value carries the
 *  throttle key — `provider::route`, or a bare provider for all its routes (empty = all). */
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
const MODEL_SCOPED_WINDOW_TYPE = 'model_scoped';

export interface RateLimitSource {
  provider: string;
  displayName: string;
  mode?: string;
}

export interface RateLimitWindowState {
  type: string;
  label?: string;
  utilization: number | null;
  resetsAt: number;
  activatedAt: number;
}

/** One throttled route of a provider — an account or other connection — keyed `provider::route`.
 *  Without a route (an outage) it covers every route of the provider. `modes` is for display. */
export interface ProviderThrottleState {
  provider: string;
  route?: string;
  displayName: string;
  modes: string[];
  windows: RateLimitWindowState[];
}

export interface RateLimitThrottleState {
  providers: ProviderThrottleState[];
}

export interface ThrottlePersistence {
  save: (state: RateLimitThrottleState | null) => Promise<void>;
  load: () => Promise<RateLimitThrottleState | null>;
}

export interface ClearedThrottleProvider {
  provider: string;
  route?: string;
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
  rateLimitLabel?: string;
  utilization?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

let _adapter: PlatformAdapter | null = null;
let _persistence: ThrottlePersistence | null = null;
let _onResume: ((providers: string[]) => void) | null = null;
let _onChange: (() => void) | null = null;
/** Extra notice buttons for a provider's throttle on one window type. */
type NoticeActionsResolver = (provider: string, windowType: string) => Promise<ActionElement[]>;
let _noticeActions: NoticeActionsResolver | null = null;
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

function entryKey(state: Pick<ProviderThrottleState, 'provider' | 'route'>): string {
  return throttleKey(state.provider, state.route);
}

/** A notice names the route unless it is the provider's own default login. */
function noticeName(state: Pick<ProviderThrottleState, 'provider' | 'route' | 'displayName'>): string {
  const own = !state.route || state.route === SUBSCRIPTION_CONNECTION || state.route === state.provider;
  return own ? state.displayName : `${state.displayName} (${state.route})`;
}

function snapshot(
  providers: ReadonlyMap<string, ProviderThrottleState> = _providers,
): ProviderThrottleState[] {
  return [...providers.values()].map(cloneProvider).sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}

function cloneProviders(): Map<string, ProviderThrottleState> {
  return new Map(snapshot().map((provider) => [entryKey(provider), provider]));
}

function publishProviders(providers: ReadonlyMap<string, ProviderThrottleState>): void {
  _providers.clear();
  for (const provider of providers.values()) _providers.set(entryKey(provider), provider);
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

function sendDM(text: string, title = t('notice.rateLimit.title'), actions?: ActionElement[]): void {
  if (!_adapter) return;
  void emitSystemNotice(_adapter, {
    text,
    level: 'warning',
    title,
    ...(actions && actions.length > 0 ? { actions } : {}),
  });
}

function clearAction(provider: string): ActionElement[] {
  return [{ type: 'button', text: t('notice.rateLimit.resumeNow'), actionId: RATE_LIMIT_CLEAR_ACTION_ID, value: provider, style: 'primary' }];
}

function formatResetTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-GB', {
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

function thresholdFor(type: string, override: number | null): number {
  return override ?? TYPE_THRESHOLDS[type] ?? DEFAULT_THRESHOLD;
}

function canonicalProvider(provider: string | null | undefined): string | null {
  const trimmed = provider?.trim();
  return trimmed ? trimmed : null;
}

/** A label is part of the identity only for a model-scoped window; elsewhere it is display text. */
function sameWindowIdentity(
  type: string,
  label: string | undefined,
  candidate: { type: string; label?: string },
): boolean {
  return candidate.type === type && (type !== MODEL_SCOPED_WINDOW_TYPE || candidate.label === label);
}

function resolveProviderPolicy(
  provider: string,
  type: string,
  label?: string,
): { enabled: boolean; threshold: number | null } {
  const override = getSettings().providerRateLimits[provider];
  const window = override?.windows?.find((candidate) => sameWindowIdentity(type, label, candidate));
  if (window) return { enabled: window.enabled, threshold: window.threshold ?? null };
  if (typeof override?.enabled === 'boolean') {
    return { enabled: override.enabled, threshold: override.threshold ?? null };
  }
  return { enabled: true, threshold: null };
}

function normalizeSource(source?: string | RateLimitSource): RateLimitSource {
  if (typeof source === 'string') {
    const provider = canonicalProvider(source) ?? 'unknown';
    return { provider, displayName: provider, mode: provider };
  }
  const provider = canonicalProvider(source?.provider);
  if (provider) {
    return {
      provider,
      displayName: source?.displayName?.trim() || provider,
      ...(source?.mode ? { mode: source.mode } : {}),
    };
  }
  return { provider: 'unknown', displayName: 'Unknown provider' };
}

function normalizeProvider(raw: ProviderThrottleState): ProviderThrottleState | null {
  if (!raw?.provider || !Array.isArray(raw.windows)) return null;
  const windows = raw.windows.filter((window) => window?.type && Number.isFinite(window.resetsAt));
  if (windows.length === 0) return null;
  return {
    provider: raw.provider,
    ...(typeof raw.route === 'string' && raw.route ? { route: raw.route } : {}),
    displayName: raw.displayName || raw.provider,
    modes: Array.isArray(raw.modes) ? uniqueSorted(raw.modes.filter(Boolean)) : [],
    windows: windows.map((window) => ({
      type: window.type,
      ...(window.label ? { label: window.label } : {}),
      utilization: Number.isFinite(window.utilization) ? window.utilization : null,
      resetsAt: window.resetsAt,
      activatedAt: Number.isFinite(window.activatedAt) ? window.activatedAt : Date.now(),
    })),
  };
}

/** An entry stored before routes held every route the provider was limited on in `modes`, with one
 *  shared set of windows. Each route gets its own entry with the quota windows; an outage stays on
 *  a route-less entry, which covers every route. */
function splitLegacyEntry(entry: ProviderThrottleState): ProviderThrottleState[] {
  if (entry?.route || !Array.isArray(entry?.modes) || entry.modes.length === 0 || !Array.isArray(entry.windows)) {
    return [entry];
  }
  const outage = entry.windows.filter((window) => window?.type === OUTAGE_WINDOW_TYPE);
  const quota = entry.windows.filter((window) => window?.type !== OUTAGE_WINDOW_TYPE);
  const routed = quota.length === 0 ? [] : entry.modes.filter(Boolean).map((mode) => ({
    ...entry, route: mode, modes: [mode], windows: quota.map((window) => ({ ...window })),
  }));
  return outage.length > 0 ? [{ ...entry, modes: [], windows: outage }, ...routed] : routed;
}

function normalizePersisted(raw: RateLimitThrottleState): ProviderThrottleState[] {
  if (!Array.isArray(raw.providers)) return [];
  return raw.providers.flatMap(splitLegacyEntry).map(normalizeProvider)
    .filter((provider): provider is ProviderThrottleState => provider !== null);
}

function windowExpiryMs(window: RateLimitWindowState): number {
  const buffer = window.type === OUTAGE_WINDOW_TYPE ? 0 : RESUME_BUFFER_MS;
  return window.resetsAt * 1000 + buffer;
}

function windowIsActive(window: RateLimitWindowState, now = Date.now()): boolean {
  return windowExpiryMs(window) > now;
}

function loadActiveProviders(raw: RateLimitThrottleState): void {
  for (const provider of normalizePersisted(raw)) {
    const windows = provider.windows.filter((window) => windowIsActive(window));
    if (windows.length > 0) _providers.set(entryKey(provider), { ...provider, windows });
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
    cleared.push({ provider: key, displayName: noticeName(provider), expiredTypes });
  }
  return cleared;
}

function clearedNotice(provider: ClearedProvider): { text: string; title?: string } {
  if (provider.expiredTypes.includes(OUTAGE_WINDOW_TYPE)) {
    return {
      text: `${Icons.ok} ${t('notice.rateLimit.outageCleared', { provider: provider.displayName })}`,
      title: t('notice.rateLimit.outageTitle'),
    };
  }
  return { text: `${Icons.ok} ${t('notice.rateLimit.cleared', { provider: provider.displayName })}` };
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
  rateLimitLabel?: string;
  utilization: number | null;
  resetsAt: number;
}

function upsertWindow(provider: ProviderThrottleState, info: WindowUpdate): boolean {
  const existing = provider.windows.find((window) => sameWindowIdentity(info.rateLimitType, info.rateLimitLabel, window));
  if (!existing) {
    provider.windows.push({
      type: info.rateLimitType,
      ...(info.rateLimitLabel ? { label: info.rateLimitLabel } : {}),
      utilization: info.utilization,
      resetsAt: info.resetsAt,
      activatedAt: Date.now(),
    });
    return true;
  }
  const nextReset = Math.max(existing.resetsAt, info.resetsAt);
  const changed = nextReset !== existing.resetsAt || info.utilization !== existing.utilization;
  existing.resetsAt = nextReset;
  existing.utilization = info.utilization;
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
  sendDM(`${Icons.warning} ${t('notice.rateLimit.outageDetected', { provider: source.displayName, at: formatResetTime(reset), remaining: formatRemaining(reset) })}`, t('notice.rateLimit.outageTitle'), clearAction(source.provider));
}

async function activateOutageWindow(provider: string | null, durationMs: number): Promise<void> {
  await _mutationMutex.run(() => activateOutageWindowLocked(provider, durationMs));
}

function shouldActivateQuota(info: RateLimitInfo, source: RateLimitSource): boolean {
  if (typeof info.utilization !== 'number' || !info.rateLimitType) return false;
  const policy = resolveProviderPolicy(source.provider, info.rateLimitType, info.rateLimitLabel);
  return policy.enabled && info.utilization >= thresholdFor(info.rateLimitType, policy.threshold);
}

async function extraNoticeActions(provider: string, windowType: string): Promise<ActionElement[]> {
  try {
    return (await _noticeActions?.(provider, windowType)) ?? [];
  } catch (error) {
    log.warn(`Rate-limit notice actions failed: ${(error as Error).message}`);
    return [];
  }
}

async function notifyQuotaActivation(
  info: RateLimitInfo, source: RateLimitSource, state: ProviderThrottleState, isNewProvider: boolean,
): Promise<void> {
  log.info(`Throttle updated: provider=${source.provider}, type=${info.rateLimitType}, utilization=${info.utilization}, mode=${source.mode ?? '(none)'}`);
  if (!isNewProvider) return;
  const actions = [...clearAction(entryKey(state)), ...await extraNoticeActions(source.provider, info.rateLimitType!)];
  sendDM(`${Icons.warning} ${t('notice.rateLimit.activated', { provider: noticeName(state), type: info.rateLimitType, pct: (info.utilization! * 100).toFixed(0), at: formatResetTime(info.resetsAt!), remaining: formatRemaining(info.resetsAt!) })}`, t('notice.rateLimit.title'), actions);
}

/** A rejection is the window at its limit: the CLI sends it without a utilization, and dropping it
 *  left a login that was refusing requests looking free to failover and to the resume queue. */
function withRejectionUtilization(info: RateLimitInfo): RateLimitInfo {
  return info.status === 'rejected' && typeof info.utilization !== 'number' ? { ...info, utilization: 1 } : info;
}

async function handleRateLimitEventLocked(raw: RateLimitInfo, rawSource?: string | RateLimitSource): Promise<void> {
  if (!raw || !_persistence || !raw.rateLimitType || !raw.resetsAt) return;
  const info = withRejectionUtilization(raw);
  const source = normalizeSource(rawSource);
  if (!shouldActivateQuota(info, source)) return;
  const candidate = cloneProviders();
  const key = throttleKey(source.provider, source.mode);
  let provider = candidate.get(key);
  const isNewProvider = !provider;
  if (!provider) {
    provider = {
      provider: source.provider, ...(source.mode ? { route: source.mode } : {}),
      displayName: source.displayName, modes: [], windows: [],
    };
    candidate.set(key, provider);
  }
  const modeAdded = !!source.mode && !provider.modes.includes(source.mode);
  if (modeAdded) provider.modes.push(source.mode!);
  const windowChanged = upsertWindow(provider, {
    rateLimitType: info.rateLimitType, rateLimitLabel: info.rateLimitLabel,
    utilization: info.utilization, resetsAt: info.resetsAt,
  });
  if (!isNewProvider && !modeAdded && !windowChanged) return;
  await persist(candidate);
  publishProviders(candidate);
  scheduleResumeTimer();
  fireChange();
  await notifyQuotaActivation(info, source, provider, isNewProvider);
}

async function handleRateLimitEvent(info: RateLimitInfo, rawSource?: string | RateLimitSource): Promise<void> {
  await _mutationMutex.run(() => handleRateLimitEventLocked(info, rawSource));
}

/** A `provider::route` key names one entry; a bare provider names every entry of it. */
function clearTargets(candidate: Map<string, ProviderThrottleState>, target?: string | null): string[] {
  if (!target) return [...candidate.keys()];
  if (candidate.has(target)) return [target];
  if (parseThrottleKey(target).route) return [];
  return [...candidate.entries()].filter(([, state]) => state.provider === target).map(([key]) => key);
}

function clearedEntry(state: ProviderThrottleState): ClearedThrottleProvider {
  return {
    provider: state.provider,
    ...(state.route ? { route: state.route } : {}),
    displayName: noticeName(state),
    types: state.windows.map((w) => w.type),
    resetsAt: state.windows.reduce((max, w) => Math.max(max, w.resetsAt), 0),
  };
}

async function clearThrottleLocked(target?: string | null): Promise<ClearThrottleResult> {
  if (!_persistence) return { cleared: [] };
  const candidate = cloneProviders();
  const targets = clearTargets(candidate, target);
  if (targets.length === 0) return { cleared: [] };

  const cleared = targets.map((key) => clearedEntry(candidate.get(key)!));
  for (const key of targets) candidate.delete(key);

  await persist(candidate);
  publishProviders(candidate);
  scheduleResumeTimer();
  fireChange();
  fireResume(targets);
  for (const item of cleared) {
    const names = item.types.join(', ');
    log.info(`Throttle manually cleared: provider=${item.provider}, route=${item.route ?? '(all)'}, types=${names}`);
    sendDM(`${Icons.ok} ${t('notice.rateLimit.clearedManually', { provider: item.displayName })}`);
  }
  return { cleared };
}

/** Manually lift an active rate-limit (or outage) throttle early: one `provider::route` entry, every
 *  entry of a bare provider, or all.
 *  Walks the same recovery path as a natural window expiry: persists the cleared state,
 *  re-schedules the resume timer, notifies the UI, and fires onResume so paused work is
 *  dispatched immediately. Idempotent — no active window yields an empty result and no notices.
 *  If the provider is actually still rate-limited, the next API call's rate-limit event
 *  re-activates the throttle automatically. */
async function clearThrottle(target?: string | null): Promise<ClearThrottleResult> {
  return _mutationMutex.run(() => clearThrottleLocked(target));
}

export interface QuotaReading {
  type: string;
  label?: string;
  utilization: number;
}

/** A quota window is recovered once a fresh reading for it sits below its activation threshold. */
function windowRecovered(provider: string, window: RateLimitWindowState, readings: QuotaReading[]): boolean {
  if (window.type === OUTAGE_WINDOW_TYPE) return false;
  const reading = readings.find((candidate) => sameWindowIdentity(window.type, window.label, candidate));
  if (!reading) return false;
  const policy = resolveProviderPolicy(provider, window.type, window.label);
  return !policy.enabled || reading.utilization < thresholdFor(window.type, policy.threshold);
}

/** `released` is the provider whose last window lifted, which also resumes its paused work. */
async function commitRelease(
  candidate: Map<string, ProviderThrottleState>,
  released: ProviderThrottleState | null,
): Promise<void> {
  await persist(candidate);
  publishProviders(candidate);
  scheduleResumeTimer();
  fireChange();
  if (!released) return;
  log.info(`Throttle released by a fresh quota reading: provider=${released.provider}, route=${released.route ?? '(none)'}`);
  sendDM(`${Icons.ok} ${t('notice.rateLimit.cleared', { provider: noticeName(released) })}`);
  fireResume([entryKey(released)]);
}

/** The entries one reading speaks for: its route's, or — named by provider alone — every route's. */
function releaseTargets(candidate: Map<string, ProviderThrottleState>, provider: string, route?: string): string[] {
  if (route) return candidate.has(throttleKey(provider, route)) ? [throttleKey(provider, route)] : [];
  return [...candidate.entries()].filter(([, state]) => state.provider === provider).map(([key]) => key);
}

async function releaseRecoveredQuotaLocked(provider: string, readings: QuotaReading[], route?: string): Promise<boolean> {
  if (!_persistence) return false;
  const candidate = cloneProviders();
  let changed = false;
  for (const key of releaseTargets(candidate, provider, route)) {
    const state = candidate.get(key)!;
    const kept = state.windows.filter((window) => !windowRecovered(provider, window, readings));
    if (kept.length === state.windows.length) continue;
    if (kept.length > 0) state.windows = kept;
    else candidate.delete(key);
    await commitRelease(candidate, kept.length === 0 ? state : null);
    changed = true;
  }
  return changed;
}

/** Lift quota windows a fresh account reading shows are no longer exhausted — e.g. after a reset
 *  spent on another device — instead of waiting out the reset time recorded at activation. The
 *  reading is one account's, so only that route's entry is touched. Never activates a throttle;
 *  outage windows are untouched. Returns whether anything changed. */
async function releaseRecoveredQuota(provider: string, readings: QuotaReading[], route?: string): Promise<boolean> {
  return _mutationMutex.run(() => releaseRecoveredQuotaLocked(provider, readings, route));
}

/** Extra buttons for a provider's throttle notice, after "Resume now". */
function setRateLimitNoticeActions(resolver: NoticeActionsResolver | null): void {
  _noticeActions = resolver;
}

function isThrottled(): boolean {
  return _providers.size > 0;
}

function entriesOf(provider: string): ProviderThrottleState[] {
  return [..._providers.values()].filter((state) => state.provider === provider);
}

/** With a route: that route's entry, or the provider's route-less one. Without: any entry of the
 *  provider. Without either: any entry at all. */
function isProviderRateLimited(provider: string | null | undefined, route?: string | null): boolean {
  if (!provider) return _providers.size > 0;
  if (route) return _providers.has(throttleKey(provider, route)) || _providers.has(provider);
  return entriesOf(provider).length > 0;
}

function isProviderUsageRateLimited(provider: string | null | undefined): boolean {
  const states = provider ? entriesOf(provider) : [..._providers.values()];
  return states.some((state) => state.windows.some((window) => window.type !== OUTAGE_WINDOW_TYPE));
}

/** Whether a dispatch on this route must wait: its own entry, or an outage of the provider. */
function isProviderModeRateLimited(provider: string, mode: string): boolean {
  if (_providers.has(throttleKey(provider, mode))) return true;
  return !!_providers.get(provider)?.windows.some((window) => window.type === OUTAGE_WINDOW_TYPE);
}

function getThrottleState(): RateLimitThrottleState {
  return { providers: snapshot() };
}

function _testReset(): void {
  cancelResumeTimer();
  _providers.clear();
  _adapter = null;
  _persistence = null;
  _onResume = null;
  _onChange = null;
  _noticeActions = null;
}

export {
  initRateLimitThrottle,
  activateOutageWindow,
  handleRateLimitEvent,
  clearThrottle,
  releaseRecoveredQuota,
  setRateLimitNoticeActions,
  isThrottled,
  isProviderRateLimited,
  isProviderUsageRateLimited,
  isProviderModeRateLimited,
  getThrottleState,
  _testReset,
};
