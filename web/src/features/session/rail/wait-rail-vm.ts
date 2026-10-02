import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { formatSpan } from '@/lib/time-format';

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

interface WaitRailCopy {
  waitingN: (n: number) => string;
  received: (got: number, need: number) => string;
  expiresIn: (d: string) => string;
  overdue: string;
  rateLimit: (limit: number) => string;
  delivery: (n: number) => string;
  quota: (used: number, limit: number) => string;
  fire: (n: number, max: number) => string;
  failures: (n: number) => string;
}

const COPY: Record<WaitRailLanguage, WaitRailCopy> = {
  en: {
    waitingN: (n) => `${n} waiting items`,
    received: (got, need) => `${got}/${need} received`,
    expiresIn: (d) => `expires in ${d}`,
    overdue: 'overdue',
    rateLimit: (limit) => `wake limit reached (${limit}/h) — signals no longer wake this session`,
    delivery: (n) => `delivery retrying · ${n} attempts`,
    quota: (used, limit) => `${used}/${limit} wakes this hour`,
    fire: (n, max) => `fire ${n}/${max}`,
    failures: (n) => `${n} failure signal${n === 1 ? '' : 's'}`,
  },
  zh: {
    waitingN: (n) => `${n} 个等待项`,
    received: (got, need) => `${got}/${need} 已回报`,
    expiresIn: (d) => `${d}后过期`,
    overdue: '已过期',
    rateLimit: (limit) => `已达唤醒上限（${limit}/时）— 后续信号不再唤醒本会话`,
    delivery: (n) => `投递重试中 · ${n} 次`,
    quota: (used, limit) => `本小时已唤醒 ${used}/${limit}`,
    fire: (n, max) => `第 ${n}/${max} 次`,
    failures: (n) => `${n} 条失败回报`,
  },
};

const URGENT_MS = 10 * 60 * 1000;

export function formatWaitClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function failureBadges(wp: WaitpointInfo, L: WaitRailCopy): WaitRailBadge[] {
  const failures = wp.signals.filter((signal) => signal.status === 'fail').length;
  return failures ? [{ key: 'failure', text: L.failures(failures), tone: 'danger' }] : [];
}

function badgesFor(wp: WaitpointInfo, L: WaitRailCopy): WaitRailBadge[] {
  const out: WaitRailBadge[] = [];
  if (wp.rateLimited) out.push({ key: 'rate-limit', text: L.rateLimit(wp.wakeLimit), tone: 'danger' });
  if (wp.delivery.pending && wp.delivery.attempts > 1) {
    out.push({
      key: 'delivery', text: L.delivery(wp.delivery.attempts), tone: 'warn',
      title: wp.delivery.lastError ?? undefined,
    });
  }
  if (!wp.rateLimited && wp.wakeLimit > 0 && wp.wakesLastHour >= wp.wakeLimit - 2 && wp.wakesLastHour > 0) {
    out.push({ key: 'quota', text: L.quota(wp.wakesLastHour, wp.wakeLimit), tone: 'warn' });
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

function toRow(wp: WaitpointInfo, now: number, lang: WaitRailLanguage): WaitRailRow {
  const L = COPY[lang];
  const left = wp.expiresAt - now;
  const signals = signalRows(wp);
  return {
    id: wp.id, label: wp.label, intent: wp.intent,
    progress: L.received(wp.quorum.got, wp.quorum.need),
    ttl: left <= 0 ? L.overdue : L.expiresIn(formatSpan(left, lang)),
    urgent: left <= URGENT_MS,
    device: wp.emitFrom.kind === 'device' ? wp.emitFrom.device : null,
    failFast: wp.failFast && wp.quorum.need > 1,
    mailbox: wp.maxSignals > 1 ? L.fire(wp.fires + 1, wp.maxSignals) : null,
    history: wp.maxSignals > 1 && wp.fires > 0,
    badges: badgesFor(wp, L), members: memberRows(wp, signals), signals,
  };
}

/** The server supplies armed waitpoints, soonest expiry first. Keep that ordering. */
export function waitRailViewModel(
  waitpoints: WaitpointInfo[], now: number, lang: WaitRailLanguage,
): WaitRailViewModel | null {
  if (waitpoints.length === 0) return null;
  const rows = waitpoints.map((wp) => toRow(wp, now, lang));
  const headline = rows.length === 1 ? rows[0].label : `${COPY[lang].waitingN(rows.length)} · ${rows[0].label}`;
  return { headline, rows };
}

export interface WaitRailChromeCopy {
  title: string;
  cancel: string;
  confirm: (label: string) => string;
  noSignals: string;
  externalNote: string;
  failFast: string;
  intent: string;
  rawSignals: string;
  reports: string;
  history: string;
  member: string;
  status: string;
  time: string;
  anonymous: string;
  signalStatus: Record<WaitRailMemberRow['status'], string>;
}

export const WAIT_RAIL_COPY: Record<WaitRailLanguage, WaitRailChromeCopy> = {
  en: {
    title: 'Waiting on', cancel: 'Cancel wait',
    confirm: (label) => `Cancel the waitpoint "${label}"? Its signal will no longer wake this session. External jobs will not be stopped.`,
    noSignals: 'No signals yet', externalNote: 'Reported by the external process',
    failFast: 'Ends on first failure', intent: 'Intent', rawSignals: 'Raw signals',
    reports: 'Member reports', history: 'Report history · all rounds',
    member: 'Member', status: 'Status', time: 'Time', anonymous: 'Anonymous',
    signalStatus: { ok: 'OK', fail: 'Failed', progress: 'Progress', pending: 'No report' },
  },
  zh: {
    title: '等待中', cancel: '取消等待',
    confirm: (label) => `取消等待点「${label}」？它的信号将不再唤醒本会话，外部作业不会停止。`,
    noSignals: '还没有信号', externalNote: '以下内容由外部进程写入',
    failFast: '任一失败即结束', intent: '等待说明', rawSignals: '原始回报',
    reports: '成员回报', history: '回报历史 · 所有轮次',
    member: '成员', status: '状态', time: '时间', anonymous: '匿名',
    signalStatus: { ok: '成功', fail: '失败', progress: '进度', pending: '未回报' },
  },
};
