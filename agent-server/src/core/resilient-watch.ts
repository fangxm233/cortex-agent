// input:  fs.watch factories and filesystem snapshots
// output: watcher monitors with polling fallback and cleanup
// pos:    Shared resilient filesystem watch lifecycle
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export const WATCH_FALLBACK_MS = 5_000;

export interface WatchMonitor {
  close(): void;
}

export interface ResilientWatchOptions {
  label: string;
  startWatching: () => FSWatcher[];
  poll?: () => void;
  warn?: (message: string) => void;
}

export interface SnapshotWatchOptions {
  label: string;
  snapshot: () => string | null;
  startWatching: (onChange: () => void) => FSWatcher[];
  onChange: () => void;
  warn?: (message: string) => void;
}

export interface FileWatchOptions {
  label: string;
  filePath: string;
  onChange: () => void;
  warn?: (message: string) => void;
  unref?: boolean;
}

interface WatchMonitorState {
  watchers: FSWatcher[];
  pollTimer: ReturnType<typeof setInterval> | null;
  failed: boolean;
  closed: boolean;
}

function formatWatchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${code}: ${error.message}` : error.message;
}

function closeWatchers(watchers: FSWatcher[]): void {
  for (const watcher of watchers.splice(0)) {
    try { watcher.close(); } catch {}
  }
}

function pollSafely(options: ResilientWatchOptions, warn: (message: string) => void): void {
  try { options.poll?.(); } catch (error) {
    warn(`${options.label} polling failed (${formatWatchError(error)})`);
  }
}

function startPolling(
  state: WatchMonitorState,
  options: ResilientWatchOptions,
  warn: (message: string) => void,
): void {
  state.pollTimer = setInterval(() => pollSafely(options, warn), WATCH_FALLBACK_MS);
  state.pollTimer.unref?.();
}

function failWatchMonitor(
  state: WatchMonitorState,
  options: ResilientWatchOptions,
  warn: (message: string) => void,
  error: unknown,
): void {
  if (state.failed || state.closed) return;
  state.failed = true;
  closeWatchers(state.watchers);
  const detail = formatWatchError(error);
  if (!options.poll) return warn(`${options.label} watcher failed (${detail}); watcher disabled`);
  warn(`${options.label} watcher failed (${detail}); polling every ${WATCH_FALLBACK_MS}ms`);
  startPolling(state, options, warn);
}

function closeWatchMonitor(state: WatchMonitorState): void {
  state.closed = true;
  closeWatchers(state.watchers);
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

export function createResilientWatchMonitor(options: ResilientWatchOptions): WatchMonitor {
  const state: WatchMonitorState = { watchers: [], pollTimer: null, failed: false, closed: false };
  const warn = options.warn ?? console.warn;
  const fallBack = (error: unknown) => failWatchMonitor(state, options, warn, error);
  try {
    state.watchers = options.startWatching();
    for (const watcher of state.watchers) watcher.on('error', fallBack);
  } catch (error) {
    fallBack(error);
  }
  return { close: () => closeWatchMonitor(state) };
}

export function createSnapshotWatchMonitor(options: SnapshotWatchOptions): WatchMonitor {
  let observedSnapshot = options.snapshot();
  const handleWatchChange = () => {
    observedSnapshot = options.snapshot();
    options.onChange();
  };
  const poll = () => {
    const nextSnapshot = options.snapshot();
    if (nextSnapshot === observedSnapshot) return;
    observedSnapshot = nextSnapshot;
    options.onChange();
  };
  return createResilientWatchMonitor({
    label: options.label,
    startWatching: () => options.startWatching(handleWatchChange),
    poll,
    warn: options.warn,
  });
}

function fileStamp(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

export function createFileWatchMonitor(options: FileWatchOptions): WatchMonitor {
  const filename = path.basename(options.filePath);
  return createSnapshotWatchMonitor({
    label: options.label,
    snapshot: () => fileStamp(options.filePath),
    onChange: options.onChange,
    warn: options.warn,
    startWatching: (onChange) => {
      const watcher = watch(path.dirname(options.filePath), (_event, changed) => {
        if (changed === null || changed.toString() === filename) onChange();
      });
      if (options.unref) watcher.unref();
      return [watcher];
    },
  });
}
