// input:  mocked fs watcher, isolated settings file
// output: init-order and null-filename watcher tests
// pos:    Settings watcher edge-case regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { beforeAll, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const watchState = vi.hoisted(() => ({
  callback: null as ((eventType: string, filename: string | Buffer | null) => void) | null,
  onWatch: null as (() => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: vi.fn((_target, callback) => {
      watchState.callback = callback as typeof watchState.callback;
      watchState.onWatch?.();
      const watcher: any = {
        close: vi.fn(),
        on: vi.fn(() => watcher),
        unref: vi.fn(() => watcher),
      };
      return watcher;
    }),
  };
});

import { CONFIG_DIR } from '../../src/core/paths.js';
import { getSettings } from '../../src/core/settings.js';

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), 'condition did not become true before timeout');
}

beforeAll(async () => {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify({ turnNotify: true }));
});

describe.sequential('settings watcher ordering', () => {
  test('attaches the watcher before reconciling the initial settings snapshot', () => {
    watchState.onWatch = () => {
      writeFileSync(SETTINGS_FILE, JSON.stringify({ turnNotify: false }));
      watchState.onWatch = null;
    };

    assert.equal(getSettings().turnNotify, false);
    assert.ok(watchState.callback, 'watch callback must be registered');
  });

  test('treats a null fs.watch filename as a settings reload candidate', async () => {
    const target = !getSettings().turnNotify;
    await fs.writeFile(SETTINGS_FILE, JSON.stringify({ turnNotify: target }));
    watchState.callback?.('rename', null);

    await waitFor(() => getSettings().turnNotify === target);
  });
});
