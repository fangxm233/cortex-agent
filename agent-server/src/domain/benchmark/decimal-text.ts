// input:  decimal strings from the proxy export and the journal cost boundary
// output: exact parse, render, compare and arithmetic over BigInt scaled units
// pos:    Exact decimal arithmetic for cost reconciliation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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

export function subtractDecimal(left: DecimalValue, right: DecimalValue): DecimalValue {
  const scale = Math.max(left.scale, right.scale);
  return { units: atScale(left, scale) - atScale(right, scale), scale };
}

export function multiplyDecimal(left: DecimalValue, right: DecimalValue): DecimalValue {
  return { units: left.units * right.units, scale: left.scale + right.scale };
}

export function compareDecimal(left: DecimalValue, right: DecimalValue): number {
  const scale = Math.max(left.scale, right.scale);
  const difference = atScale(left, scale) - atScale(right, scale);
  return difference === 0n ? 0 : Number(difference > 0n) * 2 - 1;
}

export function absDecimal(value: DecimalValue): DecimalValue {
  return value.units < 0n ? { units: -value.units, scale: value.scale } : value;
}

export function maxDecimal(left: DecimalValue, right: DecimalValue): DecimalValue {
  return compareDecimal(left, right) >= 0 ? left : right;
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

function atScale(value: DecimalValue, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}
