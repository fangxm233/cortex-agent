/** One place that puts the shim dir on PATH: a shell profile file or the Windows user Path. */
export interface PathChange {
  target: string;
  before: string | null;
  after: string | null;
}

export type PathMode = 'add' | 'remove';

export interface PathRegistrar {
  plan(dir: string, mode: PathMode): PathChange[];
  apply(changes: PathChange[]): void;
}

export const isChanged = (change: PathChange): boolean => change.before !== change.after;
