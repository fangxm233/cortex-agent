import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, PLUGINS_DIR } from '../../../src/core/paths.js';
import { handleSkillsList, handleSkillsSession } from '../../../src/domain/ui-service/query/skills.js';
import { listSkillGroups } from '../../../src/domain/plugins/catalog.js';
import { AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL as SCHEMA } from '../../../src/domain/plugins/agent-plugins-v1.js';
import { loadEnvironments } from '../../../src/domain/agents/environments/registry.js';
import { handleSkillsCmd } from '../../../src/orchestration/routing/commands/mode.js';
import { MockAdapter } from '../../../src/platform/testing.js';

// Skill listings come from the plugin catalog, the same discovery a spawn uses: a skill the
// catalog rejects (bad frontmatter, nested too deep, plugin without a manifest) is not offered.
// The built-in plugins are left out (a sealed home) so the listings hold only the fixtures; the
// catalog tests cover how built-in plugins join them.
process.env.CORTEX_CONFIG_IMMUTABLE = '1';

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

/** A plugin directory outside the plugins root, as an environment may list by absolute path. */
function externalDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-plugin-'));
  fs.mkdirSync(path.join(dir, 'skills', 'ext-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'ext-skill', 'SKILL.md'), '---\nname: ext-skill\ndescription: x\n---\n');
  fs.mkdirSync(path.join(dir, 'skills', 'not-a-skill'), { recursive: true });
  return dir;
}

test('listSkillGroups with plugin dirs lists what the session loads, in selection order', () => {
  const external = externalDir();
  // An invalid portable manifest: the spawn skips this plugin, so it lists nothing.
  fs.mkdirSync(path.join(PLUGINS_DIR, 'broken', 'skills', 'lost'), { recursive: true });
  fs.writeFileSync(path.join(PLUGINS_DIR, 'broken', 'plugin.json'), JSON.stringify({ $schema: SCHEMA, name: 'Not Valid' }));
  fs.writeFileSync(path.join(PLUGINS_DIR, 'broken', 'skills', 'lost', 'SKILL.md'), '---\nname: lost\ndescription: x\n---\n');

  assert.deepEqual(listSkillGroups({
    pluginDirs: ['plugins/beta', path.join(PLUGINS_DIR, 'alpha'), 'plugins/stray', 'plugins/broken', external],
  }), [
    { plugin: 'beta', skills: ['review'] },
    { plugin: 'alpha', skills: ['apple', 'zebra'] },
    // Not catalog plugins, but handed to the backend as they are, so their skills load.
    { plugin: 'stray', skills: ['ghost'] },
    { plugin: external, skills: ['ext-skill'] },
  ]);
  assert.deepEqual(listSkillGroups({ pluginDirs: [] }), []);
  fs.rmSync(external, { recursive: true, force: true });
});

test('!skills lists only the plugins of the environment the channel runs, external dirs included', async () => {
  const external = externalDir();
  const envDir = path.join(CONFIG_DIR, 'environments');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'main.json'), JSON.stringify({
    name: 'main', profile: '__active__', pluginDirs: ['plugins/beta', external],
  }));
  loadEnvironments();
  const adapter = new MockAdapter();
  await handleSkillsCmd('C-skills', adapter);
  const text = String(adapter.posted.at(-1)?.content.text ?? '');
  assert.match(text, /_beta_\n• `review`/);
  assert.ok(text.includes(`_${external}_\n• \`ext-skill\``), text);
  assert.doesNotMatch(text, /alpha|apple|zebra/);
  fs.rmSync(external, { recursive: true, force: true });
});

test('skills.session lists the skills a conversation loads, with what a palette offers', async () => {
  const envDir = path.join(CONFIG_DIR, 'environments');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'main.json'), JSON.stringify({
    name: 'main', profile: '__active__', pluginDirs: ['plugins/beta', 'plugins/alpha'],
  }));
  fs.writeFileSync(path.join(envDir, 'bare.json'), JSON.stringify({
    name: 'bare', profile: '__active__', pluginDirs: ['plugins/alpha'], skills: false,
  }));
  loadEnvironments();
  const sessions: Record<string, unknown> = {
    s1: { id: 's1', channel: 'web:s1', agentName: null },
    s2: { id: 's2', channel: 'web:s2', agentName: 'bare' },
  };
  const deps = { sessionStore: { getById: async (id: string) => sessions[id] ?? null } } as never;

  const draft = await handleSkillsSession(deps, {});
  assert.deepEqual(draft.map((skill) => `${skill.namespace}:${skill.name}`), ['beta:review', 'alpha:apple', 'alpha:zebra']);
  assert.equal(draft[0].description, 'test skill');
  assert.deepEqual(await handleSkillsSession(deps, { sessionId: 's1' }), draft);
  assert.deepEqual(await handleSkillsSession(deps, { sessionId: 's2' }), []);
  assert.deepEqual(await handleSkillsSession(deps, { agentName: 'bare' }), []);
});
