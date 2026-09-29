import path from 'node:path';

interface ActiveCaptureEntry {
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
      this.byPair.set(pairKey, { paths: normalized, refs: 1 });
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
}

export const activeClaudeCaptureRegistry = new ActiveClaudeCaptureRegistry();
