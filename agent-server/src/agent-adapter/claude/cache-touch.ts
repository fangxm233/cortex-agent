import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const TAIL_BYTES = 512 * 1024;

// A keep-warm refresh reads the cached prefix through a fork that never writes the transcript, so
// the transcript alone says the cache went cold earlier than it did. In memory only: a restart
// loses it, and the worst case is one cold-resume clearing that a warm cache did not need.
const refreshedAt = new Map<string, number>();

export function noteCacheRefresh(backendSessionId: string, at: number = Date.now()): void {
  refreshedAt.set(backendSessionId, at);
}

function lastTimestampIn(text: string): number | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"timestamp"')) continue;
    try {
      const record = JSON.parse(line) as { timestamp?: unknown; message?: { model?: unknown } };
      if (typeof record.timestamp !== 'string') continue;
      // The CLI writes these itself (interrupts, local errors) without calling the model.
      if (record.message?.model === '<synthetic>') continue;
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at)) return at;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * When the session last talked to the model: the newest timestamped record in its transcript.
 * Not the file's mtime — the CLI appends untimestamped `last-prompt`/`cost-state` entries when its
 * process exits, which for an idle-closed session is an hour after the last request. Falls back to
 * the mtime when the tail holds no timestamped record. Null when the transcript is missing.
 */
export function lastModelActivity(transcriptPath: string): number | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return lastTimestampIn(text) ?? stat.mtimeMs;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** When the session's prompt cache was last read or written: its last model activity or a later
 *  keep-warm refresh. Null when neither is known. */
export function lastCacheTouch(transcriptPath: string, backendSessionId: string): number | null {
  const activity = lastModelActivity(transcriptPath);
  const refreshed = refreshedAt.get(backendSessionId) ?? null;
  if (activity === null) return refreshed;
  return refreshed === null ? activity : Math.max(activity, refreshed);
}

export function resetCacheTouches(): void {
  refreshedAt.clear();
}
