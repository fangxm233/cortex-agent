import { formatUsd } from '@/lib/format';

type RelUnit = 'now' | 'min' | 'hour' | 'yesterday' | 'day' | 'week';

const REL_LABELS: Record<'en' | 'zh', Record<RelUnit, (n: number) => string>> = {
  en: { now: () => 'now', min: (n) => `${n}m`, hour: (n) => `${n}h`, yesterday: () => '1d', day: (n) => `${n}d`, week: (n) => `${n}w` },
  zh: { now: () => '刚刚', min: (n) => `${n}分钟前`, hour: (n) => `${n}小时前`, yesterday: () => '昨天', day: (n) => `${n}天前`, week: (n) => `${n}周前` },
};

function relUnit(diffMs: number): [RelUnit, number] {
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return ['now', 0];
  if (min < 60) return ['min', min];
  const hr = Math.floor(min / 60);
  if (hr < 24) return ['hour', hr];
  const day = Math.floor(hr / 24);
  if (day === 1) return ['yesterday', 1];
  return day < 7 ? ['day', day] : ['week', Math.floor(day / 7)];
}

/** Compact relative time from an ISO ts: `now / 13m / 16h / 2d` or `刚刚 / 13分钟前 / 16小时前 / 昨天`. */
export function relTime(iso: string | null | undefined, now: number, lang: 'en' | 'zh'): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const [unit, n] = relUnit(Math.max(0, now - t));
  return REL_LABELS[lang][unit](n);
}

/** Chinese relative time for screens that have no language plumbing yet. */
export function relTimeZh(iso: string | null | undefined, now: number = Date.now()): string {
  return relTime(iso, now, 'zh');
}

/** `$0.31` money label; null/undefined → em dash. */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return formatUsd(n);
}

/** en/zh copy picker for self-contained screen copy tables (avoids the shared vocab bottleneck). */
export function pickCopy<T>(lang: 'en' | 'zh', table: { en: T; zh: T }): T {
  return lang === 'zh' ? table.zh : table.en;
}
