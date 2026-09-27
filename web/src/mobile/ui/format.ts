import { formatUsd } from '@/lib/format';

export { relTime } from '@/lib/time-format';

/** `$0.31` money label; null/undefined → em dash. */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return formatUsd(n);
}

/** en/zh copy picker for self-contained screen copy tables (avoids the shared vocab bottleneck). */
export function pickCopy<T>(lang: 'en' | 'zh', table: { en: T; zh: T }): T {
  return lang === 'zh' ? table.zh : table.en;
}
