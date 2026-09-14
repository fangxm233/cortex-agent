export type TurnMutationRelease = () => void;

interface LockEntry {
  locked: boolean;
  waiters: Array<(release: TurnMutationRelease) => void>;
}

const entries = new Map<string, LockEntry>();

function releaseFor(channel: string, entry: LockEntry): TurnMutationRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = entry.waiters.shift();
    if (next) {
      next(releaseFor(channel, entry));
      return;
    }
    entry.locked = false;
    if (entries.get(channel) === entry) entries.delete(channel);
  };
}

export function tryAcquireTurnMutationLock(channel: string): TurnMutationRelease | null {
  const entry = entries.get(channel) ?? { locked: false, waiters: [] };
  entries.set(channel, entry);
  if (entry.locked) return null;
  entry.locked = true;
  return releaseFor(channel, entry);
}

export function acquireTurnMutationLock(channel: string): Promise<TurnMutationRelease> {
  const release = tryAcquireTurnMutationLock(channel);
  if (release) return Promise.resolve(release);
  const entry = entries.get(channel)!;
  return new Promise((resolve) => entry.waiters.push(resolve));
}
