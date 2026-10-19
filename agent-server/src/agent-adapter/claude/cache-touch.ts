import { statSync } from 'node:fs';

// A keep-warm refresh reads the cached prefix through a fork that never writes the transcript, so
// the transcript's mtime alone says the cache went cold earlier than it did. In memory only: a
// restart loses it, and the worst case is one cold-resume clearing that a warm cache did not need.
const refreshedAt = new Map<string, number>();

export function noteCacheRefresh(backendSessionId: string, at: number = Date.now()): void {
  refreshedAt.set(backendSessionId, at);
}

/** When the session's prompt cache was last read or written: the transcript's mtime or a later
 *  keep-warm refresh. Null when neither is known. */
export function lastCacheTouch(transcriptPath: string, backendSessionId: string): number | null {
  let mtime: number | null = null;
  try {
    mtime = statSync(transcriptPath).mtimeMs;
  } catch {
    mtime = null;
  }
  const refreshed = refreshedAt.get(backendSessionId) ?? null;
  if (mtime === null) return refreshed;
  return refreshed === null ? mtime : Math.max(mtime, refreshed);
}

export function resetCacheTouches(): void {
  refreshedAt.clear();
}
