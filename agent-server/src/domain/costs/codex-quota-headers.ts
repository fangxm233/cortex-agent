// input:  Codex response headers, a clock reading
// output: parseCodexQuotaHeaders and the quota reading types
// pos:    Turns x-codex-* quota headers into throttle windows
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/** Provider slug this reading is attributed to; matches the gateway route and profile provider. */
export const CODEX_PROVIDER = 'openai-codex';

/** The two limit buckets Codex advertises per response. `secondary` is empty on plans without a
 *  short window (pro, 2026-08), so a bucket is only real when its window length is positive. */
const FAMILIES = ['primary', 'secondary'] as const;

/** Named window lengths shared with the Claude throttle path, so state and UI stay one vocabulary. */
const WINDOW_TYPE_BY_MINUTES: Record<number, string> = {
  10080: 'seven_day',
  300: 'five_hour',
};

export interface QuotaWindow {
  /** `seven_day` / `five_hour`, else `window_<minutes>m` for a length Codex has not used before. */
  type: string;
  /** Fraction in [0,1] — Codex reports whole percents, the throttle compares against 0.95. */
  utilization: number;
  /** Epoch seconds, matching the persisted provider-state shape. */
  resetsAt: number;
}

export interface CodexQuotaReading {
  provider: typeof CODEX_PROVIDER;
  planType: string | null;
  windows: QuotaWindow[];
}

export interface ParseQuotaOpts {
  /** Injected clock: reset-after-seconds is relative, so the caller pins the reference point. */
  nowMs: number;
}

function lowerKeyed(headers: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) map.set(key.toLowerCase(), value);
  return map;
}

/** Absent, blank and unparsable values collapse to null: a missing reading must never read as 0. */
function num(map: Map<string, string>, key: string): number | null {
  const raw = map.get(key);
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function windowTypeFor(minutes: number): string {
  return WINDOW_TYPE_BY_MINUTES[minutes] ?? `window_${minutes}m`;
}

function resetsAtFor(map: Map<string, string>, family: string, nowMs: number): number | null {
  const absolute = num(map, `x-codex-${family}-reset-at`);
  if (absolute !== null && absolute > 0) return absolute;
  const after = num(map, `x-codex-${family}-reset-after-seconds`);
  return after === null ? null : Math.floor(nowMs / 1000) + after;
}

function windowFor(map: Map<string, string>, family: string, nowMs: number): QuotaWindow | null {
  const minutes = num(map, `x-codex-${family}-window-minutes`);
  if (minutes === null || minutes <= 0) return null;
  const usedPercent = num(map, `x-codex-${family}-used-percent`);
  if (usedPercent === null) return null;
  const resetsAt = resetsAtFor(map, family, nowMs);
  if (resetsAt === null) return null;
  return { type: windowTypeFor(minutes), utilization: usedPercent / 100, resetsAt };
}

/**
 * Extract the quota state Codex broadcasts on every response. Returns null when the response
 * carries no usable window — a non-Codex response, a fully disabled bucket, or a malformed
 * reading. Null means "learned nothing", never "quota is fine".
 */
export function parseCodexQuotaHeaders(
  headers: Record<string, string>,
  opts: ParseQuotaOpts,
): CodexQuotaReading | null {
  const map = lowerKeyed(headers);
  const windows: QuotaWindow[] = [];
  for (const family of FAMILIES) {
    const window = windowFor(map, family, opts.nowMs);
    if (window) windows.push(window);
  }
  if (windows.length === 0) return null;
  return { provider: CODEX_PROVIDER, planType: map.get('x-codex-plan-type') ?? null, windows };
}
