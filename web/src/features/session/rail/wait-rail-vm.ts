// input:  WaitpointInfo[] from waitpoints.list + a clock + a language
// output: WaitRailViewModel (collapsed headline + per-waitpoint rows), or null when nothing is pending
// pos:    pure view-model for WaitRail. Everything the rail decides lives here so it can be unit
//         tested without a renderer; the component only paints.

import type { WaitpointInfo } from '@cortex-agent/ui-contract';

export type WaitRailLanguage = 'en' | 'zh';

export interface WaitRailBadge {
  key: 'rate-limit' | 'delivery' | 'quota';
  text: string;
  /** `danger` = this waitpoint can no longer wake you; `warn` = it is degraded but still live. */
  tone: 'danger' | 'warn';
  /** Hover detail — the delivery error, when there is one. */
  title?: string;
}

export interface WaitRailSignalRow {
  key: string;
  at: string;
  status: 'ok' | 'fail' | 'progress';
  who: string | null;
  message: string | null;
  source: string;
}

export interface WaitRailRow {
  id: string;
  label: string;
  intent: string;
  /** "2/3 reported" — null for a single-signal waitpoint, where a fraction says nothing. */
  progress: string | null;
  /** "expires in 3h" / "overdue" */
  ttl: string;
  /** True once under ten minutes remain: the row turns urgent. */
  urgent: boolean;
  /** Device whose spool dir carries the signal, when it is not local. */
  device: string | null;
  /** "fail-fast" marker — explains a resolved waitpoint that only ever got one signal. */
  failFast: boolean;
  /** "fire 1/5" for a mailbox; null for the one-shot default. Disambiguates a progress counter
   *  that appears to go backwards after each fire. */
  mailbox: string | null;
  badges: WaitRailBadge[];
  signals: WaitRailSignalRow[];
}

export interface WaitRailViewModel {
  count: number;
  /** The one line shown while collapsed. */
  headline: string;
  rows: WaitRailRow[];
}

interface WaitRailCopy {
  waitingOne: string;
  waitingN: (n: number) => string;
  reported: (got: number, need: number) => string;
  expiresIn: (d: string) => string;
  overdue: string;
  rateLimit: (limit: number) => string;
  delivery: (n: number) => string;
  quota: (used: number, limit: number) => string;
  fire: (n: number, max: number) => string;
  failFast: string;
  on: (device: string) => string;
}

const COPY: Record<WaitRailLanguage, WaitRailCopy> = {
  en: {
    waitingOne: 'waiting on 1 signal',
    waitingN: (n: number) => `waiting on ${n} signals`,
    reported: (got: number, need: number) => `${got}/${need} reported`,
    expiresIn: (d: string) => `expires in ${d}`,
    overdue: 'overdue',
    rateLimit: (limit: number) => `wake limit reached (${limit}/h) — signals no longer wake this session`,
    delivery: (n: number) => `delivery retrying · ${n} attempts`,
    quota: (used: number, limit: number) => `${used}/${limit} wakes this hour`,
    fire: (n: number, max: number) => `fire ${n}/${max}`,
    failFast: 'fail-fast',
    on: (device: string) => `on ${device}`,
  },
  zh: {
    waitingOne: '等 1 个信号',
    waitingN: (n: number) => `等 ${n} 个信号`,
    reported: (got: number, need: number) => `${got}/${need} 已上报`,
    expiresIn: (d: string) => `${d}后过期`,
    overdue: '已过期',
    rateLimit: (limit: number) => `已达唤醒上限（${limit}/时）— 后续信号不再唤醒本会话`,
    delivery: (n: number) => `投递重试中 · ${n} 次`,
    quota: (used: number, limit: number) => `本小时已唤醒 ${used}/${limit}`,
    fire: (n: number, max: number) => `第 ${n}/${max} 次`,
    failFast: '任一失败即结束',
    on: (device: string) => `在 ${device}`,
  },
};

/** Under ten minutes left is treated as urgent — long enough to still do something about it. */
const URGENT_MS = 10 * 60 * 1000;

/** Coarse on purpose: a waitpoint that expires in a week does not need minutes. */
function formatDuration(ms: number, lang: WaitRailLanguage): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return lang === 'zh' ? `${s} 秒` : `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return lang === 'zh' ? `${m} 分钟` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return lang === 'zh' ? `${h} 小时` : `${h}h`;
  return lang === 'zh' ? `${Math.floor(h / 24)} 天` : `${Math.floor(h / 24)}d`;
}

function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Badges, most alarming first. Only `rate-limit` means "this will never wake you again"; the other
 * two are degradations worth seeing but not yet fatal. The quota badge is suppressed once the limit
 * has actually bitten, because the rate-limit badge already says it louder.
 */
function badgesFor(wp: WaitpointInfo, L: WaitRailCopy): WaitRailBadge[] {
  const out: WaitRailBadge[] = [];
  if (wp.rateLimited) out.push({ key: 'rate-limit', text: L.rateLimit(wp.wakeLimit), tone: 'danger' });
  if (wp.delivery.pending && wp.delivery.attempts > 1) {
    out.push({
      key: 'delivery',
      text: L.delivery(wp.delivery.attempts),
      tone: 'warn',
      ...(wp.delivery.lastError ? { title: wp.delivery.lastError } : {}),
    });
  }
  if (!wp.rateLimited && wp.wakeLimit > 0 && wp.wakesLastHour >= wp.wakeLimit - 2 && wp.wakesLastHour > 0) {
    out.push({ key: 'quota', text: L.quota(wp.wakesLastHour, wp.wakeLimit), tone: 'warn' });
  }
  return out;
}

function toRow(wp: WaitpointInfo, now: number, lang: WaitRailLanguage): WaitRailRow {
  const L = COPY[lang];
  const left = wp.expiresAt - now;
  return {
    id: wp.id,
    label: wp.label,
    intent: wp.intent,
    // A fraction only means something when more than one report is required.
    progress: wp.quorum.need > 1 ? L.reported(wp.quorum.got, wp.quorum.need) : null,
    ttl: left <= 0 ? L.overdue : L.expiresIn(formatDuration(left, lang)),
    urgent: left <= URGENT_MS,
    device: wp.emitFrom.kind === 'device' ? wp.emitFrom.device : null,
    failFast: wp.failFast && wp.quorum.need > 1,
    mailbox: wp.maxSignals > 1 ? L.fire(wp.fires + 1, wp.maxSignals) : null,
    badges: badgesFor(wp, L),
    signals: wp.signals.map((s, i) => ({
      key: `${wp.id}:${i}`,
      at: formatClock(s.at),
      status: s.status,
      who: s.member,
      message: s.message,
      source: s.source,
    })),
  };
}

/**
 * Returns null when the session is waiting on nothing — the rail then renders no pixels at all,
 * the same contract TodoRail keeps. Rows arrive already sorted by the server (soonest expiry
 * first); that order is preserved so the headline names the most urgent one.
 */
export function waitRailViewModel(
  waitpoints: WaitpointInfo[] | null | undefined,
  now: number,
  lang: WaitRailLanguage,
): WaitRailViewModel | null {
  if (!waitpoints || waitpoints.length === 0) return null;
  const L = COPY[lang];
  const rows = waitpoints.map((wp) => toRow(wp, now, lang));
  const first = rows[0];
  const count = rows.length;
  const headline = `${count === 1 ? L.waitingOne : L.waitingN(count)} · ${first.label} · ${first.ttl}`;
  return { count, headline, rows };
}

export interface WaitRailChromeCopy {
  title: string;
  cancel: string;
  confirm: (label: string) => string;
  noSignals: string;
  secretNote: string;
  externalNote: string;
}

/** Copy for the bits the component renders itself (labels, confirm prompt). */
export const WAIT_RAIL_COPY: Record<WaitRailLanguage, WaitRailChromeCopy> = {
  en: {
    title: 'Waiting on',
    cancel: 'cancel',
    confirm: (label: string) => `Cancel the waitpoint "${label}"? Its signal will no longer wake this session.`,
    noSignals: 'no signals yet',
    secretNote: 'The signal secret is shown once, when the waitpoint is armed — it cannot be retrieved here.',
    externalNote: 'Reported by the external process',
  },
  zh: {
    title: '等待中',
    cancel: '取消',
    confirm: (label: string) => `取消等待点「${label}」？它的信号将不再唤醒本会话。`,
    noSignals: '还没有信号',
    secretNote: '发信号用的 secret 只在布点时出现一次，这里无法重新获取。',
    externalNote: '以下内容由外部进程写入',
  },
};
