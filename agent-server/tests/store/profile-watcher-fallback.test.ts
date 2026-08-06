// input:  profiles.json and a failing fs.watch implementation
// output: polling fallback reload regression
// pos:    Profile watcher failure-path test
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: vi.fn(() => { throw new Error('watch unavailable'); }),
  };
});

import { ProfileRepo, startProfileWatcher } from '../../src/store/profile-repo.js';

const INITIAL = {
  defaultProfile: 'initial',
  profiles: { initial: { model: 'model-a' } },
};
const UPDATED = {
  defaultProfile: 'updated',
  profiles: { updated: { model: 'model-b' } },
};

afterEach(() => vi.useRealTimers());

test('profile watcher polls after fs.watch creation fails', async () => {
  vi.useFakeTimers();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-watch-fallback-'));
  const filePath = path.join(dir, 'profiles.json');
  await fs.writeFile(filePath, JSON.stringify(INITIAL));
  const repo = new ProfileRepo(filePath);
  assert.equal(repo.readSync().defaultProfile, 'initial');

  const stop = startProfileWatcher(repo, filePath);
  try {
    await fs.writeFile(filePath, JSON.stringify(UPDATED));
    await vi.advanceTimersByTimeAsync(5_300);

    assert.equal(repo.readSync().defaultProfile, 'updated');
  } finally {
    stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
