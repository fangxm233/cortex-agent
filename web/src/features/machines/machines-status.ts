import type { MachineInfo } from '@cortex-agent/ui-contract';

// The top-bar machines button carries one dot on its server glyph that sums the roster up, so the
// count beside it only has to be read when the colour says something changed.

/** `all` online (green), `some` offline (amber), `none` online (red); `unknown` while the roster is
 *  loading or failed, and for an empty roster, which has nothing to be offline — neither gets a dot. */
export type MachinesStatusTone = 'all' | 'some' | 'none' | 'unknown';

export function machinesStatusTone(machines: MachineInfo[], known: boolean): MachinesStatusTone {
  if (!known || machines.length === 0) return 'unknown';
  const online = machines.filter((machine) => machine.online).length;
  if (online === machines.length) return 'all';
  return online === 0 ? 'none' : 'some';
}

export const MACHINES_TONE_COLOR: Record<Exclude<MachinesStatusTone, 'unknown'>, string> = {
  all: 'var(--proto-success)',
  some: 'var(--proto-amber)',
  none: 'var(--proto-danger)',
};
