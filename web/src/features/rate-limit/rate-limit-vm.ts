// input:  authoritative provider/window throttle snapshot, epoch time, UI language
// output: active provider countdowns and pending-work detail rows
// pos:    Pure rate-limit presentation model shared by desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SystemRateLimitStatus } from '@cortex-agent/ui-contract';
import type { Lang } from '@/i18n';

export interface RateLimitWindowView {
  type: string;
  typeLabel: string;
  utilization: number | null;
  resetsAt: number;
  countdown: string;
}

export interface RateLimitProviderView {
  provider: string;
  displayName: string;
  recoveryAt: number;
  recoveryCountdown: string;
  waitingSessions: number;
  waitingThreads: number;
  waitingLabel: string;
  windows: RateLimitWindowView[];
}

export interface RateLimitView {
  lang: Lang;
  label: string;
  firstRecoveryAt: number;
  providers: RateLimitProviderView[];
}

function formatWindowType(type: string): string {
  if (type === 'five_hour') return '5h';
  if (type === 'seven_day' || type === 'seven_day_overage_included') return '7d';
  return type.replaceAll('_', ' ');
}

export function formatRateLimitCountdown(seconds: number): string {
  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function waitingLabel(sessions: number, threads: number, lang: Lang): string {
  if (lang === 'zh') return `${sessions} 个会话 · ${threads} 个线程等待恢复`;
  const sessionWord = sessions === 1 ? 'session' : 'sessions';
  const threadWord = threads === 1 ? 'thread' : 'threads';
  return `${sessions} ${sessionWord} · ${threads} ${threadWord} waiting`;
}

function buildProvider(
  raw: SystemRateLimitStatus['providers'][number],
  nowSec: number,
  lang: Lang,
): RateLimitProviderView | null {
  const windows = raw.windows
    .filter((window) => window.resetsAt > nowSec)
    .sort((a, b) => a.resetsAt - b.resetsAt || a.type.localeCompare(b.type))
    .map((window) => ({
      type: window.type,
      typeLabel: formatWindowType(window.type),
      utilization: window.utilization,
      resetsAt: window.resetsAt,
      countdown: formatRateLimitCountdown(window.resetsAt - nowSec),
    }));
  if (windows.length === 0) return null;
  const recoveryAt = Math.max(...windows.map((window) => window.resetsAt));
  const waitingSessions = raw.waitingSessions ?? 0;
  const waitingThreads = raw.waitingThreads ?? 0;
  return {
    provider: raw.provider,
    displayName: raw.displayName,
    recoveryAt,
    recoveryCountdown: formatRateLimitCountdown(recoveryAt - nowSec),
    waitingSessions,
    waitingThreads,
    waitingLabel: waitingLabel(waitingSessions, waitingThreads, lang),
    windows,
  };
}

function singleProviderLabel(provider: RateLimitProviderView): string {
  const types = [...new Set(provider.windows.map((window) => window.typeLabel))].join('+');
  return `${provider.displayName} · ${types} · ${provider.recoveryCountdown}`;
}

function aggregateLabel(count: number, countdown: string, lang: Lang): string {
  if (lang === 'zh') return `${count} 个 provider 限流 · 首个 ${countdown}`;
  return `${count} providers limited · first ${countdown}`;
}

export function buildRateLimitView(
  status: SystemRateLimitStatus | null | undefined,
  nowSec: number,
  lang: Lang,
): RateLimitView | null {
  const providers = (status?.providers ?? [])
    .map((provider) => buildProvider(provider, nowSec, lang))
    .filter((provider): provider is RateLimitProviderView => provider !== null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.provider.localeCompare(b.provider));
  if (providers.length === 0) return null;
  const firstRecoveryAt = Math.min(...providers.map((provider) => provider.recoveryAt));
  const firstCountdown = formatRateLimitCountdown(firstRecoveryAt - nowSec);
  return {
    lang,
    firstRecoveryAt,
    providers,
    label: providers.length === 1
      ? singleProviderLabel(providers[0])
      : aggregateLabel(providers.length, firstCountdown, lang),
  };
}
