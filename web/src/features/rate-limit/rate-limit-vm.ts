import type { SystemRateLimitStatus } from '@cortex-agent/ui-contract';
import type { Lang } from '@/i18n';
import { fmt } from '@/i18n/fmt';
import { pickVocab } from '@/i18n/lang';
import { formatSpanPrecise } from '@/i18n/time-format';
import type { ConnectionNames } from '@/lib/model-selection';

export interface RateLimitWindowView {
  type: string;
  typeLabel: string;
  resetsAt: number;
  countdown: string;
}

export interface RateLimitProviderView {
  /** `provider::route`, or the bare provider for a provider-wide outage: what a clear names. */
  key: string;
  provider: string;
  /** The provider, and a named account's label when the row belongs to one. */
  displayName: string;
  recoveryAt: number;
  recoveryCountdown: string;
  waitingLabel: string;
  windows: RateLimitWindowView[];
}

export interface RateLimitView {
  lang: Lang;
  label: string;
  providers: RateLimitProviderView[];
}

function formatWindowType(type: string): string {
  if (type === 'five_hour') return '5h';
  if (type === 'seven_day' || type === 'seven_day_overage_included') return '7d';
  return type.replaceAll('_', ' ');
}

/** Rounded up to the minute: `5m / 2h 5m / 3d 4h` · `5分钟 / 2小时5分 / 3天4小时`. */
export function formatRateLimitCountdown(seconds: number, lang: Lang): string {
  return formatSpanPrecise(Math.max(1, Math.ceil(seconds / 60)) * 60_000, lang);
}

function waitingLabel(sessions: number, lang: Lang): string {
  const L = pickVocab(lang);
  return fmt(sessions === 1 ? L.rlWaitingOne : L.rlWaitingMany, { n: sessions });
}

type RawRateLimitWindow = SystemRateLimitStatus['providers'][number]['windows'][number];

function buildWindow(window: RawRateLimitWindow, nowSec: number, lang: Lang): RateLimitWindowView {
  return {
    type: window.type,
    typeLabel: window.label ?? formatWindowType(window.type),
    resetsAt: window.resetsAt,
    countdown: formatRateLimitCountdown(window.resetsAt - nowSec, lang),
  };
}

type RawRateLimitProvider = SystemRateLimitStatus['providers'][number];

function displayName(raw: RawRateLimitProvider, names: ConnectionNames, lang: Lang): string {
  const account = raw.route && Object.hasOwn(names, raw.route) ? names[raw.route] : null;
  return account ? fmt(pickVocab(lang).accountsAccountName, { provider: raw.displayName, account }) : raw.displayName;
}

function buildProvider(
  raw: RawRateLimitProvider,
  nowSec: number,
  lang: Lang,
  names: ConnectionNames,
): RateLimitProviderView | null {
  const windows = raw.windows
    .filter((window) => window.resetsAt > nowSec)
    .sort((a, b) => a.resetsAt - b.resetsAt
      || a.type.localeCompare(b.type)
      || (a.label ?? '').localeCompare(b.label ?? ''))
    .map((window) => buildWindow(window, nowSec, lang));
  if (windows.length === 0) return null;
  const recoveryAt = Math.max(...windows.map((window) => window.resetsAt));
  const waitingSessions = raw.waitingSessions ?? 0;
  return {
    key: raw.key ?? raw.provider, provider: raw.provider, displayName: displayName(raw, names, lang), recoveryAt,
    recoveryCountdown: formatRateLimitCountdown(recoveryAt - nowSec, lang),
    waitingLabel: waitingLabel(waitingSessions, lang), windows,
  };
}

function singleProviderLabel(provider: RateLimitProviderView): string {
  return `${provider.displayName} · ${provider.recoveryCountdown}`;
}

function aggregateLabel(count: number, countdown: string, lang: Lang): string {
  return fmt(pickVocab(lang).rlAggregate, { count, countdown });
}

/** `names` labels the routes that are named accounts. */
export function buildRateLimitView(
  status: SystemRateLimitStatus | null | undefined,
  nowSec: number,
  lang: Lang,
  names: ConnectionNames = {},
): RateLimitView | null {
  const providers = (status?.providers ?? [])
    .map((provider) => buildProvider(provider, nowSec, lang, names))
    .filter((provider): provider is RateLimitProviderView => provider !== null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key));
  if (providers.length === 0) return null;
  const firstRecoveryAt = Math.min(...providers.map((provider) => provider.recoveryAt));
  const firstCountdown = formatRateLimitCountdown(firstRecoveryAt - nowSec, lang);
  return {
    lang,
    providers,
    label: providers.length === 1
      ? singleProviderLabel(providers[0])
      : aggregateLabel(providers.length, firstCountdown, lang),
  };
}
