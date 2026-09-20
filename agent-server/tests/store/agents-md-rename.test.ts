// input:  synthetic data dirs holding CORTEX.md / CORTEX.local.md at various depths
// output: assertions on renaming, skip dirs, collision safety, dangling-link cleanup, idempotence
// pos:    Covers migration S3, which moves an existing install onto the AGENTS.md name the
//         backends load natively
// >>> Once updated, update this header and parent AGENTS.md <<<
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { renameMemoryFilesToAgentsMd } from '../../src/store/version-migrations.js';

async function setup(t: { onTestFinished(callback: () => Promise<void>): void }): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-md-rename-'));
  t.onTestFinished(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function write(file: string, body = 'x'): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

test('renames CORTEX.md and CORTEX.local.md throughout the tree', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'CORTEX.md'), 'root');
  await write(path.join(dataDir, 'CORTEX.local.md'), 'root-local');
  await write(path.join(dataDir, 'context', 'projects', 'p', 'CORTEX.md'), 'nested');

  assert.equal(await renameMemoryFilesToAgentsMd(dataDir), 3);

  assert.equal(await fs.readFile(path.join(dataDir, 'AGENTS.md'), 'utf8'), 'root');
  assert.equal(await fs.readFile(path.join(dataDir, 'AGENTS.local.md'), 'utf8'), 'root-local');
  assert.equal(await fs.readFile(path.join(dataDir, 'context', 'projects', 'p', 'AGENTS.md'), 'utf8'), 'nested');
  assert.equal(await exists(path.join(dataDir, 'CORTEX.md')), false);
});

test('skips tmp/ and plugin-runtime/ — scratch workspaces and regenerated snapshots', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'tmp', 'some-clone', 'CORTEX.md'));
  await write(path.join(dataDir, 'data', 'plugin-runtime', 'claude', 'skill', 'CORTEX.md'));
  await write(path.join(dataDir, 'context', 'CORTEX.md'));

  assert.equal(await renameMemoryFilesToAgentsMd(dataDir), 1);

  assert.equal(await exists(path.join(dataDir, 'tmp', 'some-clone', 'CORTEX.md')), true);
  assert.equal(await exists(path.join(dataDir, 'data', 'plugin-runtime', 'claude', 'skill', 'CORTEX.md')), true);
  assert.equal(await exists(path.join(dataDir, 'context', 'AGENTS.md')), true);
});

test('never clobbers an existing AGENTS.md — both files are left in place', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'CORTEX.md'), 'old');
  await write(path.join(dataDir, 'AGENTS.md'), 'hand-written');

  assert.equal(await renameMemoryFilesToAgentsMd(dataDir), 0);

  assert.equal(await fs.readFile(path.join(dataDir, 'AGENTS.md'), 'utf8'), 'hand-written');
  assert.equal(await fs.readFile(path.join(dataDir, 'CORTEX.md'), 'utf8'), 'old');
});

test('clears a dangling AGENTS.md symlink before renaming onto its name', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'CORTEX.md'), 'real');
  // Installs carry AGENTS.md -> CLAUDE.md links from an old experiment; the target is long gone.
  await fs.symlink('CLAUDE.md', path.join(dataDir, 'AGENTS.md'));

  assert.equal(await renameMemoryFilesToAgentsMd(dataDir), 1);

  assert.equal(await fs.readFile(path.join(dataDir, 'AGENTS.md'), 'utf8'), 'real');
});

test('a live symlink is a real destination and blocks the rename', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'CORTEX.md'), 'real');
  await write(path.join(dataDir, 'elsewhere.md'), 'linked');
  await fs.symlink('elsewhere.md', path.join(dataDir, 'AGENTS.md'));

  assert.equal(await renameMemoryFilesToAgentsMd(dataDir), 0);

  assert.equal(await fs.readFile(path.join(dataDir, 'AGENTS.md'), 'utf8'), 'linked');
  assert.equal(await exists(path.join(dataDir, 'CORTEX.md')), true);
});

test('is idempotent — a second run renames nothing', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'context', 'CORTEX.md'));

  assert.equal(await renameMemoryFilesToAgentsMd(dataDir), 1);
  assert.equal(await renameMemoryFilesToAgentsMd(dataDir), 0);
});
