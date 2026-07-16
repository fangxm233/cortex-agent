// Shared pure formatters for the mobile v3 screens. Kept tiny + dependency-free so any screen/VM can
// import them without pulling in a sibling screen's module.

/** Relative Chinese time label from an ISO ts (scheme uses 现在 / N 分钟 / N 小时 / 昨天 / 周一…). */
export function relTimeZh(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMs = now - t;
  if (diffMs < 0) return '现在';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '现在';
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  return `${Math.floor(day / 7)} 周前`;
}

/** `$0.31` money label; null/undefined → em dash. */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}

/** en/zh copy picker for self-contained screen copy tables (avoids the shared vocab bottleneck). */
export function pickCopy<T>(lang: 'en' | 'zh', table: { en: T; zh: T }): T {
  return lang === 'zh' ? table.zh : table.en;
}
