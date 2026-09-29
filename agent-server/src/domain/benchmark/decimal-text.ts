/**
 * A decimal as an exact integer of `units` scaled by 10^-`scale`. Costs are compared across a
 * language boundary, so a binary float would make the comparison depend on representation: two
 * sides that agree on the value could disagree on the bytes. BigInt units never do.
 */
export interface DecimalValue {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL_PATTERN = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

export class DecimalTextError extends Error {
  constructor(text: string) {
    super(`not a decimal string: ${text}`);
    this.name = 'DecimalTextError';
  }
}

export function isDecimalText(text: unknown): text is string {
  return typeof text === 'string' && DECIMAL_PATTERN.test(text);
}

export function parseDecimal(text: string): DecimalValue {
  if (!isDecimalText(text)) throw new DecimalTextError(String(text));
  const [mantissa, exponent] = text.split(/[eE]/);
  const [whole, fraction = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const units = BigInt(`${whole}${fraction}`) * (text.startsWith('-') ? -1n : 1n);
  return rescale({ units, scale: fraction.length - Number(exponent ?? 0) });
}

/** Renders with trailing fraction zeros stripped, matching the proxy's own decimal serialiser. */
export function decimalText(value: DecimalValue): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const point = digits.length - value.scale;
  const fraction = value.scale > 0 ? digits.slice(point).replace(/0+$/, '') : '';
  const text = fraction ? `${digits.slice(0, point)}.${fraction}` : digits.slice(0, point);
  return negative && value.units !== 0n ? `-${text}` : text;
}

/**
 * The one lossy step in the pipeline, isolated here on purpose: a journal cost arrives as a
 * JavaScript number and its shortest round-tripping decimal is the most that value can honestly
 * claim. Everything downstream of this call is exact.
 */
export function decimalFromNumber(value: number): DecimalValue {
  if (!Number.isFinite(value)) throw new DecimalTextError(String(value));
  return parseDecimal(String(value));
}

function rescale(value: DecimalValue): DecimalValue {
  if (value.scale >= 0) return value;
  return { units: value.units * 10n ** BigInt(-value.scale), scale: 0 };
}
