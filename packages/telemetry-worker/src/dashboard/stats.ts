import type { Row } from '../env.js';
import { num } from './html.js';

/** Summed slot counts for one metric of the `histograms` report, `size` slots long. */
export function histogramCounts(rows: Row[], metric: string, size: number): number[] {
  const counts = new Array<number>(size).fill(0);
  for (const row of rows) {
    const slot = num(row.slot);
    if (row.metric === metric && slot >= 0 && slot < size) counts[slot] += num(row.count);
  }
  return counts;
}

/** Index of the slot holding the `q` quantile (0..1), or null for an empty histogram. */
export function percentileSlot(counts: number[], q: number): number | null {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;
  const target = q * total;
  let seen = 0;
  for (let slot = 0; slot < counts.length; slot++) {
    seen += counts[slot];
    if (seen >= target) return slot;
  }
  return counts.length - 1;
}

/** `≤ bound` for a bounded slot, `> last bound` for the overflow slot. */
export function slotLabel(slot: number | null, bounds: readonly number[], format: (v: number) => string): string {
  if (slot === null) return '–';
  return slot < bounds.length ? `≤ ${format(bounds[slot])}` : `> ${format(bounds[bounds.length - 1])}`;
}
