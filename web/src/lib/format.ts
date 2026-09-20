const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
export type ByteUnit = typeof BYTE_UNITS[number];

export interface FormatBytesOptions {
  fractionDigits?: number;
  trimTrailingZeros?: boolean;
  maxUnit?: ByteUnit;
}

/** Canonical USD label with exactly two fraction digits. */
export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Binary byte label with caller-selected precision and optional zero trimming. */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  const { fractionDigits = 1, trimTrailingZeros = false, maxUnit = 'TB' } = options;
  const maxUnitIndex = BYTE_UNITS.indexOf(maxUnit);
  const magnitude = Math.abs(bytes);
  let unitIndex = 0;
  while (unitIndex < maxUnitIndex && magnitude >= 1024 ** (unitIndex + 1)) unitIndex += 1;
  if (unitIndex === 0) return `${bytes} B`;
  const fixed = (bytes / 1024 ** unitIndex).toFixed(fractionDigits);
  const amount = trimTrailingZeros ? String(Number(fixed)) : fixed;
  return `${amount} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * Compact duration from a second count: `45s` / `3m` / `3m 27s`. Fractional seconds are rounded,
 * a whole minute drops the seconds part, and minutes never roll into hours (a 2h step reads
 * `120m`) — that is the contract the thread/step meta lines were each reimplementing.
 */
export function formatDurationShort(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
