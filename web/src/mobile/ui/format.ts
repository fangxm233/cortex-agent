import { formatUsd } from '@/lib/format';

export { relTime } from '@/i18n/time-format';

/** `$0.31` money label; null/undefined → em dash. */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return formatUsd(n);
}
