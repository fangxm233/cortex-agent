import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, PLUGINS_DIR } from '../../../src/core/paths.js';
import { handleSkillsList } from '../../../src/domain/ui-service/query/skills.js';
import { listSkillGroups } from '../../../src/domain/plugins/catalog.js';
import { AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL as SCHEMA } from '../../../src/domain/plugins/agent-plugins-v1.js';
import { loadEnvironments } from '../../../src/domain/agents/environments/registry.js';
import { handleSkillsCmd } from '../../../src/orchestration/routing/commands/mode.js';
import { MockAdapter } from '../../../src/platform/testing.js';

// Skill listings come from the plugin catalog, the same discovery a spawn uses: a skill the
// catalog rejects (bad frontmatter, nested too deep, plugin without a manifest) is not offered.

function writePlugin(id: string): string {
  const root = path.join(PLUGINS_DIR, id);
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ $schema: SCHEMA, name: id }));
  return root;
}

function writeSkill(pluginRoot: string, relDir: string, frontmatterName = path.basename(relDir)): void {
  const dir = path.join(pluginRoot, 'skills', relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${frontmatterName}\ndescription: test skill\n---\n`);
}

beforeEach(() => {
  fs.rmSync(PLUGINS_DIR, { recursive: true, force: true });
  const alpha = writePlugin('alpha');
  writeSkill(alpha, 'zebra');
  writeSkill(alpha, 'apple');
  writeSkill(alpha, 'mismatch', 'other-name');
  writeSkill(alpha, path.join('group', 'nested'));
  const beta = writePlugin('beta');
  writeSkill(beta, 'review');
  // No manifest: not a catalog plugin, so its skills never load and are not listed.
  fs.mkdirSync(path.join(PLUGINS_DIR, 'stray', 'skills', 'ghost'), { recursive: true });
  fs.writeFileSync(path.join(PLUGINS_DIR, 'stray', 'skills', 'ghost', 'SKILL.md'), '---\nname: ghost\ndescription: x\n---\n');
});

test('skills.list lists every catalog plugin with its loadable skills, sorted', async () => {
  const result = await handleSkillsList({} as never, {});
  assert.deepEqual(result, [
    { plugin: 'alpha', skills: ['apple', 'zebra'] },
    { plugin: 'beta', skills: ['review'] },
  ]);
});

test('listSkillGroups with plugin dirs lists only those plugins, in selection order', () => {
  assert.deepEqual(listSkillGroups({ pluginDirs: ['plugins/beta', path.join(PLUGINS_DIR, 'alpha'), 'plugins/stray'] }), [
    { plugin: 'beta', skills: ['review'] },
    { plugin: 'alpha', skills: ['apple', 'zebra'] },
  ]);
  assert.deepEqual(listSkillGroups({ pluginDirs: [] }), []);
});

test('!skills lists only the plugins of the environment the channel runs', async () => {
  const envDir = path.join(CONFIG_DIR, 'environments');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'main.json'), JSON.stringify({
    name: 'main', profile: '__active__', pluginDirs: ['plugins/beta'],
  }));
  loadEnvironments();
  const adapter = new MockAdapter();
  await handleSkillsCmd('C-skills', adapter);
  const text = String(adapter.posted.at(-1)?.content.text ?? '');
  assert.match(text, /_beta_\n• `review`/);
  assert.doesNotMatch(text, /alpha|apple|zebra/);
});
