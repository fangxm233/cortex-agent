// input:  thread-template directory and a failing fs.watch implementation
// output: polling fallback and registration-race regressions
// pos:    Thread config watcher failure-path test
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { CONFIG_DIR } from '../../src/core/paths.js';

const watchState = vi.hoisted(() => ({
  fail: true,
  onWatch: null as (() => void) | null,
  callbacks: [] as Array<(...args: unknown[]) => void>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: vi.fn((_target, callback) => {
      if (watchState.fail) throw new Error('watch unavailable');
      watchState.callbacks.push(callback as (...args: unknown[]) => void);
      watchState.onWatch?.();
      watchState.onWatch = null;
      const watcher: any = { close: vi.fn(), on: vi.fn(() => watcher) };
      return watcher;
    }),
  };
});

const ROOT = path.join(CONFIG_DIR, 'thread-templates');
const TEMPLATE_FILE = path.join(ROOT, 'templates', 'simple.json');
const AGENT = {
  name: 'executor',
  profile: '__active__',
  persistSession: true,
  promptTemplate: 'execute',
};

function writeTemplate(description: string): void {
  writeFileSync(TEMPLATE_FILE, JSON.stringify({
    name: 'simple', description, agents: ['executor'], transitions: [],
    entryAgent: 'executor', maxTotalSteps: 1,
  }));
}

afterEach(() => vi.useRealTimers());

function writeFixture(description: string): void {
  rmSync(ROOT, { recursive: true, force: true });
  for (const sub of ['agents', 'templates', 'shells']) {
    mkdirSync(path.join(ROOT, sub), { recursive: true });
  }
  writeFileSync(path.join(ROOT, 'agents', 'executor.json'), JSON.stringify(AGENT));
  writeTemplate(description);
}

test('thread config polling detects same-size content with a preserved mtime', async () => {
  vi.useFakeTimers();
  const fixedTime = new Date('2024-01-01T00:00:00.000Z');
  writeFixture('before');
  utimesSync(TEMPLATE_FILE, fixedTime, fixedTime);
  const loader = await import('../../src/domain/threads/template-loader.js');
  loader.loadConfig();
  assert.equal(loader.getTemplate('simple')?.description, 'before');

  loader.startConfigWatcher();
  try {
    writeTemplate('update');
    utimesSync(TEMPLATE_FILE, fixedTime, fixedTime);
    await vi.advanceTimersByTimeAsync(5_300);

    assert.equal(loader.getTemplate('simple')?.description, 'update');
  } finally {
    loader.stopConfigWatcher();
  }
});

test('thread config watcher reconciles registration changes without replay', async () => {
  vi.useFakeTimers();
  watchState.fail = false;
  watchState.callbacks.length = 0;
  writeFixture('before-registration');
  const loader = await import('../../src/domain/threads/template-loader.js');
  loader.loadConfig();
  watchState.onWatch = () => writeTemplate('during-registration');
  const notices: string[] = [];
  loader.setAdminNotifier((text) => notices.push(text));

  loader.startConfigWatcher();
  try {
    await vi.advanceTimersByTimeAsync(300);
    assert.equal(loader.getTemplate('simple')?.description, 'during-registration');
    assert.equal(notices.length, 1);

    watchState.callbacks[0]?.();
    await vi.advanceTimersByTimeAsync(300);
    assert.equal(notices.length, 1);
  } finally {
    loader.stopConfigWatcher();
    loader.setAdminNotifier(() => {});
    watchState.fail = true;
  }
});
