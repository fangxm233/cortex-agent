// input:  syncManagedPlugins / parsePluginVersion (store/plugin-sync) over temp src/dst dirs
// output: unit tests — version-managed plugin deploy/refresh semantics
// pos:    regression for "new plugins / updated skills never reach existing installs": init copies
//         plugins only on `cortex init` (copy-if-missing), so syncManagedPlugins must deploy a new
//         plugin, refresh a deployed one when the shipped plugin.json version is newer, bring legacy
//         (unversioned) copies under management, never downgrade, never touch unversioned defaults,
//         and preserve user-added files inside a managed plugin.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncManagedPlugins, parsePluginVersion } from '../../src/store/plugin-sync.js';

/** Write a plugin tree under `root/<name>`: a versioned manifest (version=null → omit) + a SKILL.md. */
async function writePlugin(
  root: string,
  name: string,
  version: string | null,
  skillBody = 'shipped skill',
): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.mkdir(path.join(dir, 'skills', 's'), { recursive: true });
  const manifest: Record<string, unknown> = { name, description: 'x' };
  if (version !== null) manifest.version = version;
  await fs.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(dir, 'skills', 's', 'SKILL.md'), skillBody);
}

async function readSkill(root: string, name: string): Promise<string> {
  return fs.readFile(path.join(root, name, 'skills', 's', 'SKILL.md'), 'utf8');
}

async function mkdirs(): Promise<{ src: string; dst: string; cleanup: () => Promise<void> }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-sync-'));
  const src = path.join(base, 'defaults-plugins');
  const dst = path.join(base, 'data-plugins');
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(dst, { recursive: true });
  return { src, dst, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

test('parsePluginVersion extracts version, or null when absent/malformed', () => {
  assert.equal(parsePluginVersion('{"version":"0.1.0"}'), '0.1.0');
  assert.equal(parsePluginVersion('{"version":"2026.6.22-2"}'), '2026.6.22-2');
  assert.equal(parsePluginVersion('{"name":"x"}'), null);
  assert.equal(parsePluginVersion('not json'), null);
  assert.equal(parsePluginVersion('{"version":""}'), null);
});

test('(a) deploys a brand-new plugin when the destination is missing', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await writePlugin(src, 'cortex-new', '0.1.0');

  const updated = await syncManagedPlugins({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, ['cortex-new']);
  assert.ok(existsSync(path.join(dst, 'cortex-new', '.claude-plugin', 'plugin.json')), 'manifest deployed');
  assert.equal(await readSkill(dst, 'cortex-new'), 'shipped skill', 'skill deployed');
});

test('(b) refreshes an updated skill when the shipped version is newer', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await writePlugin(src, 'cortex-x', '0.2.0', 'NEW skill');
  await writePlugin(dst, 'cortex-x', '0.1.0', 'OLD skill');

  const updated = await syncManagedPlugins({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, ['cortex-x']);
  assert.equal(await readSkill(dst, 'cortex-x'), 'NEW skill', 'deployed skill refreshed');
});

test('(c) brings a legacy UNversioned deployed plugin under management (counts as oldest)', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await writePlugin(src, 'cortex-x', '0.2.0', 'NEW skill');
  await writePlugin(dst, 'cortex-x', null, 'LEGACY skill'); // no version in manifest

  const updated = await syncManagedPlugins({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, ['cortex-x']);
  assert.equal(await readSkill(dst, 'cortex-x'), 'NEW skill', 'legacy copy refreshed');
});

test('(d) leaves a current deployed plugin untouched (same version → no write)', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await writePlugin(src, 'cortex-x', '0.1.0', 'SHIPPED skill');
  await writePlugin(dst, 'cortex-x', '0.1.0', 'LOCAL skill');

  const updated = await syncManagedPlugins({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, [], 'no update when versions match');
  assert.equal(await readSkill(dst, 'cortex-x'), 'LOCAL skill', 'existing content preserved');
});

test('(e) never downgrades when the deployed plugin is newer than the shipped default', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await writePlugin(src, 'cortex-x', '0.1.0', 'OLD shipped');
  await writePlugin(dst, 'cortex-x', '0.2.0', 'NEWER deployed');

  const updated = await syncManagedPlugins({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, [], 'no downgrade');
  assert.equal(await readSkill(dst, 'cortex-x'), 'NEWER deployed', 'newer deployed copy kept');
});

test('(f) ignores unversioned defaults — left to init copy-if-missing', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await writePlugin(src, 'cortex-x', null, 'unmanaged'); // no version → unmanaged

  const updated = await syncManagedPlugins({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, [], 'unversioned default not synced');
  assert.ok(!existsSync(path.join(dst, 'cortex-x')), 'unversioned default not deployed by sync');
});

test('(g) preserves a user-added file inside a managed plugin across a refresh', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await writePlugin(src, 'cortex-x', '0.2.0', 'NEW skill');
  await writePlugin(dst, 'cortex-x', '0.1.0', 'OLD skill');
  // A skill the user created locally — not part of the shipped tree.
  await fs.mkdir(path.join(dst, 'cortex-x', 'skills', 'mine'), { recursive: true });
  await fs.writeFile(path.join(dst, 'cortex-x', 'skills', 'mine', 'SKILL.md'), 'user skill');

  const updated = await syncManagedPlugins({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, ['cortex-x']);
  assert.equal(await readSkill(dst, 'cortex-x'), 'NEW skill', 'shipped skill refreshed');
  assert.ok(existsSync(path.join(dst, 'cortex-x', 'skills', 'mine', 'SKILL.md')), 'user-added skill preserved');
  assert.equal(
    await fs.readFile(path.join(dst, 'cortex-x', 'skills', 'mine', 'SKILL.md'), 'utf8'),
    'user skill',
    'user-added content untouched',
  );
});
