import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(() => { throw new Error('watch unavailable'); }) };
});
import { ModelsRepo, startModelsWatcher } from '../../src/store/models-repo.js';
const selection = { backend: 'claude', provider: null, model: 'model-a', thinking: null, mode: 'plan' };
afterEach(() => vi.useRealTimers());

test('models watcher polls after fs.watch creation fails', async () => {
  vi.useFakeTimers();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-watch-fallback-'));
  const filePath = path.join(dir, 'models.json');
  await fs.writeFile(filePath, JSON.stringify({ default: selection, favorites: [] }));
  const repo = new ModelsRepo(filePath);
  assert.equal(repo.readSync().default.model, 'model-a');
  const stop = startModelsWatcher(repo, filePath);
  try {
    await fs.writeFile(filePath, JSON.stringify({ default: { ...selection, model: 'model-b' }, favorites: [] }));
    await vi.advanceTimersByTimeAsync(5_300);
    assert.equal(repo.readSync().default.model, 'model-b');
  } finally {
    stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
