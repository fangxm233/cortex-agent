// input:  numeric USD amounts, byte counts, and byte precision options
// output: canonical dollar and binary byte-size labels
// pos:    Shared locale-neutral formatting primitives for every Web UI surface
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
