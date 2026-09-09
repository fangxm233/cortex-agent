// input:  retireTemplatePluginRefs (store/plugin-retirement) over a temp DATA_DIR
// output: unit tests — one-shot rewrite of deployed agent templates' pluginDirs
// pos:    regression for "trimming a plugin from defaults/ is a no-op for existing installs":
//         plugin-sync never deletes and `cortex init` never runs on upgrade, so this rewrite is the
//         only thing that unwires a retired plugin or wires a newly shipped one. Pins the
//         customization discriminator (stock copies lose their ref, locally re-versioned ones keep
//         it), the never-delete-files rule, and the sentinel that makes it run exactly once.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  retireTemplatePluginRefs, TEMPLATE_PLUGIN_REFS_KEY,
} from '../../src/store/plugin-retirement.js';

async function setup(t: { onTestFinished(cb: () => Promise<void>): void }): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-retirement-'));
  t.onTestFinished(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, 'config', 'thread-templates', 'agents'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'data'), { recursive: true });
  return dataDir;
}

function agentPath(dataDir: string, name: string): string {
  return path.join(dataDir, 'config', 'thread-templates', 'agents', `${name}.json`);
}

async function writeAgent(dataDir: string, name: string, pluginDirs: unknown): Promise<void> {
  const body: Record<string, unknown> = { name, description: 'x' };
  if (pluginDirs !== undefined) body.pluginDirs = pluginDirs;
  await fs.writeFile(agentPath(dataDir, name), JSON.stringify(body, null, 2) + '\n');
}

async function readDirs(dataDir: string, name: string): Promise<unknown> {
  const raw = JSON.parse(await fs.readFile(agentPath(dataDir, name), 'utf8'));
  return raw.pluginDirs;
}

/** Deploy a plugin copy into DATA_DIR/plugins with a manifest version and one skill file. */
async function deployPlugin(dataDir: string, name: string, version: string | null): Promise<void> {
  const dir = path.join(dataDir, 'plugins', name);
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.mkdir(path.join(dir, 'skills', 's'), { recursive: true });
  const manifest: Record<string, unknown> = { name, description: 'x' };
  if (version !== null) manifest.version = version;
  await fs.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(dir, 'skills', 's', 'SKILL.md'), 'body');
}

async function sentinel(dataDir: string): Promise<string | undefined> {
  const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'data', 'versions.json'), 'utf8'));
  return raw[TEMPLATE_PLUGIN_REFS_KEY];
}

test('drops a stock retired plugin and keeps everything else', async (t) => {
  const dataDir = await setup(t);
  await deployPlugin(dataDir, 'cortex-common', '0.1.5'); // exactly the last shipped version
  await deployPlugin(dataDir, 'cortex-system', '0.5.0');
  await writeAgent(dataDir, 'manager', [
    'plugins/cortex-common', 'plugins/cortex-system', 'plugins/cortex-feishu',
  ]);

  const changed = await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(changed, ['manager.json']);
  assert.deepEqual(await readDirs(dataDir, 'manager'), ['plugins/cortex-system', 'plugins/cortex-feishu']);
});

test('drops a dead reference whose plugin directory is already gone', async (t) => {
  const dataDir = await setup(t);
  await writeAgent(dataDir, 'writer', ['plugins/cortex-common', 'plugins/cortex-writer']);

  await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(await readDirs(dataDir, 'writer'), ['plugins/cortex-writer']);
});

test('keeps a retired plugin the user re-versioned locally, and its files', async (t) => {
  const dataDir = await setup(t);
  await deployPlugin(dataDir, 'cortex-coder', '0.2.0'); // above the 0.1.2 we last shipped
  await writeAgent(dataDir, 'coder', ['plugins/cortex-coder']);

  const changed = await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(changed, []);
  assert.deepEqual(await readDirs(dataDir, 'coder'), ['plugins/cortex-coder']);
  assert.ok(existsSync(path.join(dataDir, 'plugins', 'cortex-coder', 'skills', 's', 'SKILL.md')));
});

test('keeps a retired plugin whose manifest cannot be read', async (t) => {
  const dataDir = await setup(t);
  await deployPlugin(dataDir, 'cortex-stage-gate', null); // no version → cannot prove it is ours
  await writeAgent(dataDir, 'director', ['plugins/cortex-stage-gate']);

  await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(await readDirs(dataDir, 'director'), ['plugins/cortex-stage-gate']);
});

test('never deletes the files of a retired plugin it unwires', async (t) => {
  const dataDir = await setup(t);
  await deployPlugin(dataDir, 'cortex-common', '0.1.0');
  await writeAgent(dataDir, 'main', ['plugins/cortex-common']);

  await retireTemplatePluginRefs({ dataDir });

  assert.ok(existsSync(path.join(dataDir, 'plugins', 'cortex-common', 'skills', 's', 'SKILL.md')));
});

test('adds a newly shipped plugin dir only to the agents that ship it', async (t) => {
  const dataDir = await setup(t);
  await writeAgent(dataDir, 'main', ['plugins/cortex-system']);
  await writeAgent(dataDir, 'executor', ['plugins/cortex-system']);

  await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(await readDirs(dataDir, 'main'), ['plugins/cortex-system', 'plugins/cortex-commission']);
  assert.deepEqual(await readDirs(dataDir, 'executor'), ['plugins/cortex-system']);
});

test('does not duplicate a plugin dir the template already lists', async (t) => {
  const dataDir = await setup(t);
  await writeAgent(dataDir, 'direct', ['plugins/cortex-system', 'plugins/cortex-commission']);

  const changed = await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(changed, []);
  assert.deepEqual(await readDirs(dataDir, 'direct'), ['plugins/cortex-system', 'plugins/cortex-commission']);
});

test('leaves references outside DATA_DIR/plugins alone', async (t) => {
  const dataDir = await setup(t);
  const outside = path.join(dataDir, 'vendor', 'cortex-common');
  await writeAgent(dataDir, 'surveyor', [outside, 'plugins/nested/cortex-common']);

  const changed = await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(changed, []);
  assert.deepEqual(await readDirs(dataDir, 'surveyor'), [outside, 'plugins/nested/cortex-common']);
});

test('runs once: a re-added plugin dir survives the next boot', async (t) => {
  const dataDir = await setup(t);
  await deployPlugin(dataDir, 'cortex-common', '0.1.5');
  await writeAgent(dataDir, 'main', ['plugins/cortex-common', 'plugins/cortex-system']);

  await retireTemplatePluginRefs({ dataDir });
  assert.ok(await sentinel(dataDir), 'sentinel must be stamped');

  // The user decides they want the old plugin back.
  await writeAgent(dataDir, 'main', ['plugins/cortex-common', 'plugins/cortex-system']);
  const second = await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(second, []);
  assert.deepEqual(await readDirs(dataDir, 'main'), ['plugins/cortex-common', 'plugins/cortex-system']);
});

test('stamps the sentinel and skips agents without pluginDirs', async (t) => {
  const dataDir = await setup(t);
  await writeAgent(dataDir, 'gate', undefined);
  await fs.writeFile(agentPath(dataDir, 'broken'), '{ not json');

  const changed = await retireTemplatePluginRefs({ dataDir });

  assert.deepEqual(changed, []);
  assert.ok(await sentinel(dataDir));
  assert.equal(await fs.readFile(agentPath(dataDir, 'broken'), 'utf8'), '{ not json');
});

test('tolerates an install with no agents directory', async (t) => {
  const dataDir = await setup(t);
  await fs.rm(path.join(dataDir, 'config'), { recursive: true, force: true });

  assert.deepEqual(await retireTemplatePluginRefs({ dataDir }), []);
  assert.ok(await sentinel(dataDir));
});
