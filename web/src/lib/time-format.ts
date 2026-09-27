// One vocabulary for every time label in the UI, in the UI language. English stays compact
// (`12m`, `3h 5m`, `12m ago`); Chinese spells the units with no space (`12分钟`, `3小时5分`, `12分钟前`).

export type TimeLang = 'en' | 'zh';

type Unit = 's' | 'm' | 'h' | 'd' | 'w';

const UNIT: Record<TimeLang, Record<Unit, string>> = {
  en: { s: 's', m: 'm', h: 'h', d: 'd', w: 'w' },
  zh: { s: '秒', m: '分钟', h: '小时', d: '天', w: '周' },
};

// Two-part spans shorten the minute in Chinese: 3分20秒, 2小时5分, 2天3小时.
const PRECISE_ZH: Record<'d' | 'h' | 'm' | 's', string> = { d: '天', h: '小时', m: '分', s: '秒' };

const JUST_NOW: Record<TimeLang, string> = { en: 'just now', zh: '刚刚' };
const NOW_COMPACT: Record<TimeLang, string> = { en: 'now', zh: '刚刚' };
const YESTERDAY: Record<TimeLang, string> = { en: 'Yesterday', zh: '昨天' };
const TODAY: Record<TimeLang, string> = { en: 'Today', zh: '今天' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function unit(n: number, u: Unit, lang: TimeLang): string {
  return `${n}${UNIT[lang][u]}`;
}

/** Largest whole unit of a span, seconds through days. */
function largest(ms: number): [number, Unit] {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return [s, 's'];
  const m = Math.floor(s / 60);
  if (m < 60) return [m, 'm'];
  const h = Math.floor(m / 60);
  return h < 24 ? [h, 'h'] : [Math.floor(h / 24), 'd'];
}

/** A span, largest unit only: `45s / 12m / 3h / 2d` · `45秒 / 12分钟 / 3小时 / 2天`. */
export function formatSpan(ms: number, lang: TimeLang): string {
  const [n, u] = largest(ms);
  return unit(n, u, lang);
}

type PreciseUnit = 'd' | 'h' | 'm' | 's';

/** Largest unit of a span with the next one down: seconds → [m, s], minutes → [h, m], hours → [d, h]. */
function twoUnits(s: number): [number, number, PreciseUnit, PreciseUnit] {
  const m = Math.floor(s / 60);
  if (m < 60) return [m, s % 60, 'm', 's'];
  const h = Math.floor(m / 60);
  return h < 24 ? [h, m % 60, 'h', 'm'] : [Math.floor(h / 24), h % 24, 'd', 'h'];
}

/** A span to two units, dropping a zero minor: `45s / 3m 20s / 2h / 2d 3h` · `45秒 / 3分20秒 / 2小时 / 2天3小时`. */
export function formatSpanPrecise(ms: number, lang: TimeLang): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return unit(s, 's', lang);
  const [major, minor, mu, nu] = twoUnits(s);
  if (lang === 'zh') return `${major}${PRECISE_ZH[mu]}${minor ? `${minor}${PRECISE_ZH[nu]}` : ''}`;
  return minor ? `${major}${mu} ${minor}${nu}` : `${major}${mu}`;
}

function parse(at: string | number | null | undefined): number | null {
  if (at == null || at === '') return null;
  const t = typeof at === 'number' ? at : Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

/** How long ago, compact for a list column: `now / 12m / 3h / 1d / 2w` · `刚刚 / 12分钟前 / 3小时前 / 昨天 / 2周前`. '' when unknown. */
export function relTime(at: string | number | null | undefined, now: number, lang: TimeLang): string {
  const t = parse(at);
  if (t == null) return '';
  const [n, u] = largest(now - t);
  if (u === 's') return NOW_COMPACT[lang];
  if (lang === 'zh' && u === 'd' && n === 1) return YESTERDAY.zh;
  const [count, shown]: [number, Unit] = u === 'd' && n >= 7 ? [Math.floor(n / 7), 'w'] : [n, u];
  return lang === 'zh' ? `${unit(count, shown, 'zh')}前` : unit(count, shown, 'en');
}

/** How long ago, inside a sentence: `just now / 12m ago / 3h ago` · `刚刚 / 12分钟前 / 3小时前`. '' when unknown. */
export function timeAgo(at: string | number | null | undefined, now: number, lang: TimeLang): string {
  const t = parse(at);
  if (t == null) return '';
  const [n, u] = largest(now - t);
  if (u === 's') return JUST_NOW[lang];
  return lang === 'zh' ? `${unit(n, u, 'zh')}前` : `${unit(n, u, 'en')} ago`;
}

/** How long until: `in 12m` · `12分钟后`. Callers decide what an instant already past reads as. */
export function timeUntil(at: string | number | null | undefined, now: number, lang: TimeLang): string {
  const t = parse(at);
  if (t == null) return '';
  const span = formatSpan(t - now, lang);
  return lang === 'zh' ? `${span}后` : `in ${span}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Calendar-day label: `Today / Yesterday / Sep 24` · `今天 / 昨天 / 9月24日`. */
export function dayLabel(ts: string | number, now: Date, lang: TimeLang): string {
  const d = new Date(ts);
  const delta = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (delta <= 0) return TODAY[lang];
  if (delta === 1) return YESTERDAY[lang];
  return lang === 'zh' ? `${d.getMonth() + 1}月${d.getDate()}日` : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local wall clock `HH:MM`. */
export function clockTime(ts: string | number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local `YYYY-MM-DD HH:MM` (language-neutral); null when missing or unparseable. */
export function dateTime(at: string | number | null | undefined): string | null {
  const t = parse(at);
  if (t == null) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(d)}`;
}
