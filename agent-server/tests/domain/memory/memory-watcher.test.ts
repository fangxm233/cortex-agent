import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startMemoryWatcher, stopMemoryWatcher } from '../../../src/domain/memory/watcher.js';

afterEach(() => stopMemoryWatcher());

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a project created after startup is watched and its index regenerated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-watcher-'));
  try {
    fs.mkdirSync(path.join(root, 'existing', 'experiments'), { recursive: true });
    const regens: string[] = [];
    startMemoryWatcher({ projectsDir: root, regen: (project) => regens.push(project), debounceMs: 50 });

    // New project, then its experiments directory, then a file — the order project-init uses.
    fs.mkdirSync(path.join(root, 'fresh'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    fs.mkdirSync(path.join(root, 'fresh', 'experiments'));
    await waitFor(() => regens.includes('fresh'));

    regens.length = 0;
    fs.writeFileSync(path.join(root, 'fresh', 'experiments', 'EXP-001.md'), '---\nid: EXP-001\n---\n');
    await waitFor(() => regens.includes('fresh'));

    regens.length = 0;
    fs.writeFileSync(path.join(root, 'existing', 'experiments', 'EXP-001.md'), '---\nid: EXP-001\n---\n');
    await waitFor(() => regens.includes('existing'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
