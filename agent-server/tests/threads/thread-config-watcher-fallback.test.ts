// input:  thread-template directory and a failing fs.watch implementation
// output: polling fallback reload regression
// pos:    Thread config watcher failure-path test
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { CONFIG_DIR } from '../../src/core/paths.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: vi.fn(() => { throw new Error('watch unavailable'); }),
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

test('thread config watcher polls after fs.watch creation fails', async () => {
  vi.useFakeTimers();
  rmSync(ROOT, { recursive: true, force: true });
  for (const sub of ['agents', 'templates', 'shells']) {
    mkdirSync(path.join(ROOT, sub), { recursive: true });
  }
  writeFileSync(path.join(ROOT, 'agents', 'executor.json'), JSON.stringify(AGENT));
  writeTemplate('before');
  const loader = await import('../../src/domain/threads/template-loader.js');
  loader.loadConfig();
  assert.equal(loader.getTemplate('simple')?.description, 'before');

  loader.startConfigWatcher();
  try {
    writeTemplate('after-polling');
    await vi.advanceTimersByTimeAsync(5_300);

    assert.equal(loader.getTemplate('simple')?.description, 'after-polling');
  } finally {
    loader.stopConfigWatcher();
  }
});
