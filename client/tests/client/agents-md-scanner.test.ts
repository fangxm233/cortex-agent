// input:  temp directory trees carrying AGENTS.md / AGENTS.local.md at various depths
// output: assertions on ancestor order, .local pickup, mtime, size cap, dedup, missing target
// pos:    Covers the scanner the client bundles and runs ON the remote device — the only
//         surviving AGENTS.md scanner now that both backends load local files natively
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanAgentsMDChain } from '../../src/agents-md-scanner.js';

async function mkTmp(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'cmd-scan-'));
}

async function rmTmp(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

test('scanAgentsMDChain finds AGENTS.md in ancestor directories (leaf → root order)', async () => {
  const root = await mkTmp();
  try {
    const l1 = path.join(root, 'a');
    const l2 = path.join(l1, 'b');
    await fs.promises.mkdir(l2, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'root-content');
    await fs.promises.writeFile(path.join(l1, 'AGENTS.md'), 'a-content');
    await fs.promises.writeFile(path.join(l2, 'target.txt'), 'hello');

    const entries = scanAgentsMDChain(path.join(l2, 'target.txt'));
    const paths = entries.map(e => e.path);
    const l1Idx = paths.indexOf(path.join(l1, 'AGENTS.md'));
    const rootIdx = paths.indexOf(path.join(root, 'AGENTS.md'));
    assert.ok(l1Idx >= 0, 'l1 AGENTS.md found');
    assert.ok(rootIdx >= 0, 'root AGENTS.md found');
    assert.ok(l1Idx < rootIdx, 'leaf (l1) should come before root in entries');
  } finally {
    await rmTmp(root);
  }
});

test('scanAgentsMDChain includes AGENTS.local.md alongside AGENTS.md', async () => {
  const root = await mkTmp();
  try {
    await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'public');
    await fs.promises.writeFile(path.join(root, 'AGENTS.local.md'), 'private');
    await fs.promises.writeFile(path.join(root, 'target.txt'), 'hello');
    const entries = scanAgentsMDChain(path.join(root, 'target.txt'));
    const names = entries.map(e => path.basename(e.path));
    assert.ok(names.includes('AGENTS.md'), 'AGENTS.md included');
    assert.ok(names.includes('AGENTS.local.md'), 'AGENTS.local.md included');
  } finally {
    await rmTmp(root);
  }
});

test('scanAgentsMDChain records mtimeMs for each entry', async () => {
  const root = await mkTmp();
  try {
    const p = path.join(root, 'AGENTS.md');
    await fs.promises.writeFile(p, 'content');
    const entries = scanAgentsMDChain(path.join(root, 'target.txt'));
    const match = entries.find(e => e.path === p);
    assert.ok(match, 'entry present');
    assert.strictEqual(typeof match!.mtimeMs, 'number');
    assert.ok(match!.mtimeMs > 0, 'mtimeMs is positive');
    assert.strictEqual(match!.content, 'content');
    assert.strictEqual(match!.deviceId, os.hostname(), 'entry carries canonical physical host identity');
  } finally {
    await rmTmp(root);
  }
});

test('scanAgentsMDChain skips files larger than 200 KB', async () => {
  const root = await mkTmp();
  try {
    const p = path.join(root, 'AGENTS.md');
    await fs.promises.writeFile(p, 'x'.repeat(300 * 1024));
    await fs.promises.writeFile(path.join(root, 'target.txt'), 'h');
    const entries = scanAgentsMDChain(path.join(root, 'target.txt'));
    assert.ok(!entries.some(e => e.path === p), 'oversized AGENTS.md excluded');
  } finally {
    await rmTmp(root);
  }
});

test('scanAgentsMDChain deduplicates by absolute path (no repeated entries)', async () => {
  const root = await mkTmp();
  try {
    const l1 = path.join(root, 'a');
    await fs.promises.mkdir(l1, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'r');
    await fs.promises.writeFile(path.join(l1, 'target.txt'), 'h');
    const entries = scanAgentsMDChain(path.join(l1, 'target.txt'));
    const rootPaths = entries.filter(e => e.path === path.join(root, 'AGENTS.md'));
    assert.strictEqual(rootPaths.length, 1, 'each AGENTS.md appears at most once');
  } finally {
    await rmTmp(root);
  }
});

test('scanAgentsMDChain works when target parent exists but file does not (write/edit scenario)', async () => {
  const root = await mkTmp();
  try {
    const l1 = path.join(root, 'a');
    await fs.promises.mkdir(l1, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'root');
    await fs.promises.writeFile(path.join(l1, 'AGENTS.md'), 'l1');
    const entries = scanAgentsMDChain(path.join(l1, 'will-be-created.txt'));
    const paths = entries.map(e => e.path);
    assert.ok(paths.includes(path.join(l1, 'AGENTS.md')), 'scans parent even if file missing');
    assert.ok(paths.includes(path.join(root, 'AGENTS.md')), 'walks up to root');
  } finally {
    await rmTmp(root);
  }
});
