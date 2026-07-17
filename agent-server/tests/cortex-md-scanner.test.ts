// input:  Node test runner + scanCortexMDChain + fs/path/os
// output: leaf→root ancestor scan regression tests
// pos:    Verify CORTEX.md ancestor scan order and filtering
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanCortexMDChain } from '../src/domain/memory/cortex-md-scanner.js';

async function mkTmp(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'cmd-scan-'));
}

async function rmTmp(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

test('scanCortexMDChain finds CORTEX.md in ancestor directories (leaf → root order)', async () => {
  const root = await mkTmp();
  try {
    const l1 = path.join(root, 'a');
    const l2 = path.join(l1, 'b');
    await fs.promises.mkdir(l2, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'root-content');
    await fs.promises.writeFile(path.join(l1, 'CORTEX.md'), 'a-content');
    await fs.promises.writeFile(path.join(l2, 'target.txt'), 'hello');

    const entries = scanCortexMDChain(path.join(l2, 'target.txt'));
    const paths = entries.map(e => e.path);
    const l1Idx = paths.indexOf(path.join(l1, 'CORTEX.md'));
    const rootIdx = paths.indexOf(path.join(root, 'CORTEX.md'));
    assert.ok(l1Idx >= 0, 'l1 CORTEX.md found');
    assert.ok(rootIdx >= 0, 'root CORTEX.md found');
    assert.ok(l1Idx < rootIdx, 'leaf (l1) should come before root in entries');
  } finally {
    await rmTmp(root);
  }
});

test('scanCortexMDChain includes CORTEX.local.md alongside CORTEX.md', async () => {
  const root = await mkTmp();
  try {
    await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'public');
    await fs.promises.writeFile(path.join(root, 'CORTEX.local.md'), 'private');
    await fs.promises.writeFile(path.join(root, 'target.txt'), 'hello');
    const entries = scanCortexMDChain(path.join(root, 'target.txt'));
    const names = entries.map(e => path.basename(e.path));
    assert.ok(names.includes('CORTEX.md'), 'CORTEX.md included');
    assert.ok(names.includes('CORTEX.local.md'), 'CORTEX.local.md included');
  } finally {
    await rmTmp(root);
  }
});

test('scanCortexMDChain handles non-existent target path silently', () => {
  const entries = scanCortexMDChain('/tmp/definitely-does-not-exist-xyz123-abc/sub/dir/file.txt');
  assert.ok(Array.isArray(entries), 'returns an array even for non-existent path');
});

test('scanCortexMDChain records mtimeMs for each entry', async () => {
  const root = await mkTmp();
  try {
    const p = path.join(root, 'CORTEX.md');
    await fs.promises.writeFile(p, 'content');
    const entries = scanCortexMDChain(path.join(root, 'target.txt'));
    const match = entries.find(e => e.path === p);
    assert.ok(match, 'entry present');
    assert.strictEqual(typeof match!.mtimeMs, 'number');
    assert.ok(match!.mtimeMs > 0, 'mtimeMs is positive');
    assert.strictEqual(match!.content, 'content');
  } finally {
    await rmTmp(root);
  }
});

test('scanCortexMDChain skips files larger than 200 KB', async () => {
  const root = await mkTmp();
  try {
    const p = path.join(root, 'CORTEX.md');
    await fs.promises.writeFile(p, 'x'.repeat(300 * 1024));
    await fs.promises.writeFile(path.join(root, 'target.txt'), 'h');
    const entries = scanCortexMDChain(path.join(root, 'target.txt'));
    assert.ok(!entries.some(e => e.path === p), 'oversized CORTEX.md excluded');
  } finally {
    await rmTmp(root);
  }
});

test('scanCortexMDChain deduplicates by absolute path (no repeated entries)', async () => {
  const root = await mkTmp();
  try {
    const l1 = path.join(root, 'a');
    await fs.promises.mkdir(l1, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'r');
    await fs.promises.writeFile(path.join(l1, 'target.txt'), 'h');
    const entries = scanCortexMDChain(path.join(l1, 'target.txt'));
    const rootPaths = entries.filter(e => e.path === path.join(root, 'CORTEX.md'));
    assert.strictEqual(rootPaths.length, 1, 'each CORTEX.md appears at most once');
  } finally {
    await rmTmp(root);
  }
});

test('scanCortexMDChain works when target parent exists but file does not (write/edit scenario)', async () => {
  const root = await mkTmp();
  try {
    const l1 = path.join(root, 'a');
    await fs.promises.mkdir(l1, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'root');
    await fs.promises.writeFile(path.join(l1, 'CORTEX.md'), 'l1');
    const entries = scanCortexMDChain(path.join(l1, 'will-be-created.txt'));
    const paths = entries.map(e => e.path);
    assert.ok(paths.includes(path.join(l1, 'CORTEX.md')), 'scans parent even if file missing');
    assert.ok(paths.includes(path.join(root, 'CORTEX.md')), 'walks up to root');
  } finally {
    await rmTmp(root);
  }
});
