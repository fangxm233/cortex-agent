// input:  fake filesystem watchers and snapshots
// output: watcher failure fallback and cleanup regressions
// pos:    Resilient watcher-to-polling lifecycle tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  createResilientWatchMonitor,
  createSnapshotWatchMonitor,
} from '../../src/core/resilient-watch.js';

class FakeWatcher extends EventEmitter {
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }
}

afterEach(() => vi.useRealTimers());

test('falls back to polling every 5 seconds when watcher creation fails', () => {
  vi.useFakeTimers();
  const warnings: string[] = [];
  let polls = 0;
  const quotaError = Object.assign(new Error('inotify limit reached'), { code: 'EMFILE' });

  const monitor = createResilientWatchMonitor({
    label: 'config',
    startWatching: () => { throw quotaError; },
    poll: () => { polls += 1; },
    warn: (message) => warnings.push(message),
  });

  vi.advanceTimersByTime(4_999);
  assert.equal(polls, 0);
  vi.advanceTimersByTime(1);
  assert.equal(polls, 1);
  assert.match(warnings.join('\n'), /EMFILE.*polling every 5000ms/);

  monitor.close();
  vi.advanceTimersByTime(5_000);
  assert.equal(polls, 1);
});

test('runtime watcher errors close all watchers and start one fallback timer', () => {
  vi.useFakeTimers();
  const first = new FakeWatcher();
  const second = new FakeWatcher();
  let polls = 0;
  const monitor = createResilientWatchMonitor({
    label: 'config',
    startWatching: () => [first as any, second as any],
    poll: () => { polls += 1; },
    warn: () => {},
  });

  const quotaError = Object.assign(new Error('watch quota reached'), { code: 'ENOSPC' });
  first.emit('error', quotaError);
  second.emit('error', quotaError);
  vi.advanceTimersByTime(5_000);

  assert.equal(first.closeCalls, 1);
  assert.equal(second.closeCalls, 1);
  assert.equal(polls, 1);
  monitor.close();
});

test('snapshot monitor reloads only after the observed snapshot changes', () => {
  vi.useFakeTimers();
  let snapshot = 'before';
  let reloads = 0;
  const monitor = createSnapshotWatchMonitor({
    label: 'settings.json',
    snapshot: () => snapshot,
    startWatching: () => { throw new Error('watch unavailable'); },
    onChange: () => { reloads += 1; },
    warn: () => {},
  });

  vi.advanceTimersByTime(5_000);
  assert.equal(reloads, 0);
  snapshot = 'after';
  vi.advanceTimersByTime(5_000);
  assert.equal(reloads, 1);
  vi.advanceTimersByTime(5_000);
  assert.equal(reloads, 1);

  monitor.close();
});

test('watch events refresh the snapshot baseline before polling fallback', () => {
  vi.useFakeTimers();
  const watcher = new FakeWatcher();
  let notifyWatchChange: (() => void) | null = null;
  let snapshot = 'before';
  let reloads = 0;
  const monitor = createSnapshotWatchMonitor({
    label: 'profiles.json',
    snapshot: () => snapshot,
    startWatching: (onChange) => {
      notifyWatchChange = onChange;
      return [watcher as any];
    },
    onChange: () => { reloads += 1; },
    warn: () => {},
  });

  snapshot = 'after';
  notifyWatchChange?.();
  watcher.emit('error', new Error('watch failed'));
  vi.advanceTimersByTime(5_000);

  assert.equal(reloads, 1, 'polling must not replay a change already observed by fs.watch');
  monitor.close();
});
