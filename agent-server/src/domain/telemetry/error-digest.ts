import { groupKeyOf, redactMessage, redactStack } from './redact.js';
import { updateRollup } from './rollup.js';
import type { RawRollup } from './rollup-types.js';

const MAX_SAMPLES = 5;

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try { return JSON.stringify(arg) ?? String(arg); } catch { return String(arg); }
}

/** A stable group for one `log.error` call: the error's own frame, else its message shape. */
export function describeLogError(module: string, args: unknown[]): { groupKey: string; message: string } {
  const message = redactMessage(args.map(formatArg).join(' '));
  const error = args.find((arg): arg is Error => arg instanceof Error);
  if (error?.stack) {
    const key = groupKeyOf(error.name || 'Error', redactStack(error.stack));
    if (!key.endsWith('@unknown')) return { groupKey: `${module}:${key}`.slice(0, 200), message };
  }
  const shape = message.replace(/\d+/g, '#').slice(0, 120);
  return { groupKey: `${module}:${shape}`.slice(0, 200), message };
}

function addSample(rollup: RawRollup, module: string, args: unknown[]): void {
  const { samples } = rollup.errors;
  const { groupKey, message } = describeLogError(module, args);
  const existing = samples.find((sample) => sample.groupKey === groupKey);
  if (existing) existing.count += 1;
  else if (samples.length < MAX_SAMPLES) samples.push({ module, groupKey, message, count: 1 });
}

/** The `log.error` sink: count per module, keep one redacted sample for up to five groups. */
export function recordErrorLog(module: string, args: unknown[]): void {
  updateRollup((rollup) => {
    rollup.errors.byModule[module] = (rollup.errors.byModule[module] ?? 0) + 1;
    addSample(rollup, module, args);
  });
}
