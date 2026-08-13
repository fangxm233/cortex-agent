// input:  active Claude turn capture paths/pairs
// output: queryable in-process registry of live capture files
// pos:    Claude adapter-local liveness state for retention protection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import path from 'node:path';

interface ActiveCaptureEntry {
  pairKey: string;
  paths: string[];
  refs: number;
}

export class ActiveClaudeCaptureRegistry {
  private byPair = new Map<string, ActiveCaptureEntry>();

  register(pairKey: string, paths: string[]): () => void {
    const normalized = paths.map((value) => path.resolve(value));
    const entry = this.byPair.get(pairKey);
    if (entry) {
      entry.refs += 1;
      for (const filePath of normalized) {
        if (!entry.paths.includes(filePath)) entry.paths.push(filePath);
      }
    } else {
      this.byPair.set(pairKey, { pairKey, paths: normalized, refs: 1 });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.byPair.get(pairKey);
      if (!current) return;
      current.refs -= 1;
      if (current.refs <= 0) this.byPair.delete(pairKey);
    };
  }

  listPaths(): string[] {
    const out = new Set<string>();
    for (const entry of this.byPair.values()) {
      for (const filePath of entry.paths) out.add(filePath);
    }
    return [...out];
  }

  listPairs(): string[] {
    return [...this.byPair.keys()];
  }

  clear(): void {
    this.byPair.clear();
  }
}

export const activeClaudeCaptureRegistry = new ActiveClaudeCaptureRegistry();
