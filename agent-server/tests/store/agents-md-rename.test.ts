// input:  synthetic data dirs holding CORTEX.md / CORTEX.local.md at various depths
// output: assertions on renaming, skip dirs, collision safety, dangling-link cleanup, idempotence,
//         plus the S4 rule-file rename and its reference repair
// pos:    Covers migrations S3 and S4, which move an existing install onto the AGENTS.md name
//         the backends load natively — the memory files, then the rule describing them
// >>> Once updated, update this header and parent AGENTS.md <<<
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { renameIndexRuleFile, renameMemoryFilesToAgentsMd } from '../../src/store/version-migrations.js';

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

// ── S4: the rule file describing the convention ────────────────

test('renames the index rule file and retargets the glob inside it', async (t) => {
  const dataDir = await setup(t);
  await write(
    path.join(dataDir, 'rules', 'cortex-md.md'),
    '---\nglobs:\n  - "context/**/CORTEX.md"\n---\n# CORTEX.md 索引规范\n',
  );

  assert.equal(await renameIndexRuleFile(dataDir), 1);

  const moved = await fs.readFile(path.join(dataDir, 'rules', 'agents-md.md'), 'utf8');
  assert.match(moved, /context\/\*\*\/AGENTS\.md/);
  assert.match(moved, /# AGENTS\.md 索引规范/);
  assert.equal(await exists(path.join(dataDir, 'rules', 'cortex-md.md')), false);
});

test('repairs sibling rules that cite the old rule file by name', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'rules', 'cortex-md.md'), 'glob: context/**/CORTEX.md');
  await write(path.join(dataDir, 'rules', 'meta-conventions.md'), '更新该目录的 CORTEX.md 索引（规范见 cortex-md.md）。');
  await write(path.join(dataDir, 'rules', 'unrelated.md'), 'no mention here');

  await renameIndexRuleFile(dataDir);

  const meta = await fs.readFile(path.join(dataDir, 'rules', 'meta-conventions.md'), 'utf8');
  assert.equal(meta, '更新该目录的 AGENTS.md 索引（规范见 agents-md.md）。');
  assert.equal(await fs.readFile(path.join(dataDir, 'rules', 'unrelated.md'), 'utf8'), 'no mention here');
});

test('never clobbers an agents-md.md that is already there', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'rules', 'cortex-md.md'), 'old');
  await write(path.join(dataDir, 'rules', 'agents-md.md'), 'hand-written');

  await renameIndexRuleFile(dataDir);

  assert.equal(await fs.readFile(path.join(dataDir, 'rules', 'agents-md.md'), 'utf8'), 'hand-written');
  assert.equal(await fs.readFile(path.join(dataDir, 'rules', 'cortex-md.md'), 'utf8'), 'old');
});

test('is a no-op on a fresh install, where init seeded the new name', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'rules', 'agents-md.md'), 'glob: context/**/AGENTS.md');

  assert.equal(await renameIndexRuleFile(dataDir), 0);
});

test('running twice changes nothing the second time', async (t) => {
  const dataDir = await setup(t);
  await write(path.join(dataDir, 'rules', 'cortex-md.md'), 'glob: context/**/CORTEX.md');

  assert.equal(await renameIndexRuleFile(dataDir), 1);
  assert.equal(await renameIndexRuleFile(dataDir), 0);
});

test('tolerates an install with no rules directory at all', async (t) => {
  const dataDir = await setup(t);
  assert.equal(await renameIndexRuleFile(dataDir), 0);
});
