import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';
import { formatSpan } from '@/i18n/time-format';

export type WaitRailLanguage = 'en' | 'zh';

export interface WaitRailBadge {
  key: 'rate-limit' | 'delivery' | 'quota' | 'failure';
  text: string;
  tone: 'danger' | 'warn';
  title?: string;
}

export interface WaitRailSignalRow {
  key: string;
  at: string;
  timestamp: number;
  status: 'ok' | 'fail' | 'progress';
  who: string | null;
  message: string | null;
  source: string;
}

export interface WaitRailMemberRow {
  key: string;
  who: string | null;
  status: WaitRailSignalRow['status'] | 'pending';
  timestamp: number | null;
}

export interface WaitRailRow {
  id: string;
  label: string;
  intent: string;
  /** Server quorum: terminal reporters received, NOT successes or number of log entries. */
  progress: string;
  ttl: string;
  urgent: boolean;
  device: string | null;
  failFast: boolean;
  mailbox: string | null;
  /** Mailbox logs survive counter resets; the DTO has no per-fire boundary. */
  history: boolean;
  badges: WaitRailBadge[];
  members: WaitRailMemberRow[];
  signals: WaitRailSignalRow[];
}

export interface WaitRailViewModel {
  headline: string;
  rows: WaitRailRow[];
}

/** Words the view-model needs; the rail chrome reads the rest of the `wait*` keys directly. */
export type WaitRailVocab = Pick<Vocab, 'waitWaitingN' | 'waitReceived' | 'waitExpiresIn' | 'waitOverdue' | 'waitRateLimit'
  | 'waitDelivery' | 'waitQuota' | 'waitFire' | 'waitFailureOne' | 'waitFailureMany'>;

const URGENT_MS = 10 * 60 * 1000;

export function formatWaitClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function failureBadges(wp: WaitpointInfo, L: WaitRailVocab): WaitRailBadge[] {
  const failures = wp.signals.filter((signal) => signal.status === 'fail').length;
  return failures ? [{ key: 'failure', text: fmt(failures === 1 ? L.waitFailureOne : L.waitFailureMany, { n: failures }), tone: 'danger' }] : [];
}

function badgesFor(wp: WaitpointInfo, L: WaitRailVocab): WaitRailBadge[] {
  const out: WaitRailBadge[] = [];
  if (wp.rateLimited) out.push({ key: 'rate-limit', text: fmt(L.waitRateLimit, { limit: wp.wakeLimit }), tone: 'danger' });
  if (wp.delivery.pending && wp.delivery.attempts > 1) {
    out.push({
      key: 'delivery', text: fmt(L.waitDelivery, { n: wp.delivery.attempts }), tone: 'warn',
      title: wp.delivery.lastError ?? undefined,
    });
  }
  if (!wp.rateLimited && wp.wakeLimit > 0 && wp.wakesLastHour >= wp.wakeLimit - 2 && wp.wakesLastHour > 0) {
    out.push({ key: 'quota', text: fmt(L.waitQuota, { used: wp.wakesLastHour, limit: wp.wakeLimit }), tone: 'warn' });
  }
  return [...out, ...failureBadges(wp, L)];
}

function signalRows(wp: WaitpointInfo): WaitRailSignalRow[] {
  return wp.signals.map((s, i) => ({
    key: `${wp.id}:${i}`, at: formatWaitClock(s.at), timestamp: s.at,
    status: s.status, who: s.member, message: s.message, source: s.source,
  }));
}

function memberReport(key: string, who: string | null, signals: WaitRailSignalRow[]): WaitRailMemberRow {
  // A heartbeat after a terminal report must not undo it. Repeated terminals use the latest one.
  const terminal = signals.filter((signal) => signal.status !== 'progress');
  const latest = terminal.at(-1) ?? signals.at(-1);
  return { key, who, status: latest?.status ?? 'pending', timestamp: latest?.timestamp ?? null };
}

function memberRows(wp: WaitpointInfo, signals: WaitRailSignalRow[]): WaitRailMemberRow[] {
  const names = new Set([...wp.quorum.members, ...signals.flatMap((s) => s.who ? [s.who] : [])]);
  const named = [...names].map((who) => memberReport(`member:${who}`, who, signals.filter((s) => s.who === who)));
  // Anonymous signals have no stable reporter identity, including progress; never merge them.
  const anonymous = signals.filter((s) => !s.who).map((s) => memberReport(s.key, s.who, [s]));
  return [...named, ...anonymous];
}

function toRow(wp: WaitpointInfo, now: number, L: WaitRailVocab, lang: WaitRailLanguage): WaitRailRow {
  const left = wp.expiresAt - now;
  const signals = signalRows(wp);
  return {
    id: wp.id, label: wp.label, intent: wp.intent,
    progress: fmt(L.waitReceived, { got: wp.quorum.got, need: wp.quorum.need }),
    ttl: left <= 0 ? L.waitOverdue : fmt(L.waitExpiresIn, { d: formatSpan(left, lang) }),
    urgent: left <= URGENT_MS,
    device: wp.emitFrom.kind === 'device' ? wp.emitFrom.device : null,
    failFast: wp.failFast && wp.quorum.need > 1,
    mailbox: wp.maxSignals > 1 ? fmt(L.waitFire, { n: wp.fires + 1, max: wp.maxSignals }) : null,
    history: wp.maxSignals > 1 && wp.fires > 0,
    badges: badgesFor(wp, L), members: memberRows(wp, signals), signals,
  };
}

/** The server supplies armed waitpoints, soonest expiry first. Keep that ordering. */
export function waitRailViewModel(
  waitpoints: WaitpointInfo[], now: number, L: WaitRailVocab, lang: WaitRailLanguage,
): WaitRailViewModel | null {
  if (waitpoints.length === 0) return null;
  const rows = waitpoints.map((wp) => toRow(wp, now, L, lang));
  const headline = rows.length === 1 ? rows[0].label : `${fmt(L.waitWaitingN, { n: rows.length })} · ${rows[0].label}`;
  return { headline, rows };
}

/** Label for a member / signal status cell. */
export function waitStatusText(status: WaitRailMemberRow['status'], L: Vocab): string {
  switch (status) {
    case 'ok': return L.waitStatusOk;
    case 'fail': return L.cmFailed;
    case 'progress': return L.waitStatusProgress;
    default: return L.waitStatusPending;
  }
}
