// input:  plugin fixtures plus the authoring handlers
// output: skill edit/lifecycle, plugin lifecycle, containment and MCP secret coverage
// pos:    ui-service plugin authoring regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import '../../_test-home.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, test } from 'vitest';
import { CONFIG_DIR, PLUGINS_DIR } from '../../../src/core/paths.js';
import {
  AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
  AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
} from '../../../src/domain/plugins/agent-plugins-v1.js';
import {
  handlePluginsConvertToPortable,
  handlePluginsCreate,
  handlePluginsMcpWrite,
  handlePluginsRemove,
  handlePluginsSkillCreate,
  handlePluginsSkillMove,
  handlePluginsSkillRemove,
  handlePluginsSkillWrite,
} from '../../../src/domain/ui-service/mutate/plugin-packages.js';
import {
  handlePluginsMcpRead,
  handlePluginsSkillFile,
} from '../../../src/domain/ui-service/query/plugin-source.js';
import { handlePluginsList } from '../../../src/domain/ui-service/query/plugins.js';
import type { Result, UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const TT_DIR = path.join(CONFIG_DIR, 'thread-templates');

function deps(): UiServiceDeps {
  return {
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    bus: { publish: () => {}, subscribe: () => ({ unsubscribe: () => {} }) },
  } as unknown as UiServiceDeps;
}

function skillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

function seedPlugin(id: string, skills: readonly string[]): void {
  const dir = path.join(PLUGINS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), `${JSON.stringify({
    $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
    name: id,
    version: '1.0.0',
  }, null, 2)}\n`, 'utf8');
  for (const skill of skills) {
    mkdirSync(path.join(dir, 'skills', skill), { recursive: true });
    writeFileSync(
      path.join(dir, 'skills', skill, 'SKILL.md'),
      skillMarkdown(skill, `${skill} helper skill`),
      'utf8',
    );
  }
}

function seedLegacyPlugin(id: string): void {
  const dir = path.join(PLUGINS_DIR, id);
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: id, version: '2.3.4', description: 'legacy pack' }, null, 2)}\n`,
    'utf8',
  );
  mkdirSync(path.join(dir, 'skills', 'old'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'old', 'SKILL.md'), skillMarkdown('old', 'old skill'), 'utf8');
}

function seedMcp(id: string): void {
  const dir = path.join(PLUGINS_DIR, id);
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'bin', 'server'), '#!/bin/sh\n', 'utf8');
  writeFileSync(path.join(dir, 'mcp.json'), `${JSON.stringify({
    $schema: AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
    mcpServers: {
      local: {
        type: 'stdio',
        command: './bin/server',
        args: ['--verbose'],
        env: { SECRET_TOKEN: 'super-secret-env' },
      },
      remote: {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer super-secret-header' },
      },
    },
  }, null, 2)}\n`, 'utf8');
}

function agentBody(name: string, pluginDirs?: string[]) {
  return {
    name,
    description: `${name} agent`,
    profile: 'plan',
    persistSession: true,
    tools: 'Read',
    entryStage: 'work',
    stages: { work: { promptTemplate: 'work: {{input}}' } },
    ...(pluginDirs ? { pluginDirs } : {}),
  };
}

function seedAgent(name: string, pluginDirs?: string[]): void {
  const dir = path.join(TT_DIR, 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(agentBody(name, pluginDirs), null, 2)}\n`, 'utf8');
}

beforeEach(() => {
  rmSync(TT_DIR, { recursive: true, force: true });
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  mkdirSync(TT_DIR, { recursive: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
  seedPlugin('alpha', ['review']);
  seedPlugin('beta', []);
  seedMcp('alpha');
  seedAgent('writer', ['plugins/alpha']);
});

function ok<T>(result: Result<T>): T {
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  return (result as { ok: true; data: T }).data;
}

function err<T>(result: Result<T>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected failure');
  return result as { ok: false; code: string; message: string };
}

test('reads a SKILL.md with its hash and reports whether Cortex ships it', async () => {
  const file = await handlePluginsSkillFile(deps(), { pluginId: 'alpha', skill: 'review' });

  assert.equal(file.path, 'plugins/alpha/skills/review/SKILL.md');
  assert.match(file.content, /name: review/);
  assert.equal(file.managed, false);
  assert.match(file.baseHash, /^[a-f0-9]{64}$/);
});

test('writes a SKILL.md only when the caller started from what is on disk', async () => {
  const file = await handlePluginsSkillFile(deps(), { pluginId: 'alpha', skill: 'review' });
  const next = skillMarkdown('review', 'edited description');

  const saved = ok(await handlePluginsSkillWrite(deps(), {
    pluginId: 'alpha', skill: 'review', content: next, baseHash: file.baseHash,
  }));
  assert.notEqual(saved.baseHash, file.baseHash);

  const stale = err(await handlePluginsSkillWrite(deps(), {
    pluginId: 'alpha', skill: 'review', content: 'x', baseHash: file.baseHash,
  }));
  assert.equal(stale.code, 'conflict');
  assert.equal(
    readFileSync(path.join(PLUGINS_DIR, 'alpha', 'skills', 'review', 'SKILL.md'), 'utf8'),
    next,
  );
});

test('creates a skill the catalog can immediately load', async () => {
  ok(await handlePluginsSkillCreate(deps(), {
    pluginId: 'beta', skill: 'summarize', description: 'Summarize a document.',
  }));

  const { plugins } = await handlePluginsList(deps(), {});
  const beta = plugins.find((plugin) => plugin.id === 'beta');
  assert.deepEqual(beta?.skills, [{ name: 'summarize', description: 'Summarize a document.', managed: false }]);
});

test('refuses to create a skill that already exists', async () => {
  const failure = err(await handlePluginsSkillCreate(deps(), {
    pluginId: 'alpha', skill: 'review', description: 'again',
  }));

  assert.equal(failure.code, 'invalid-args');
  assert.match(failure.message, /already exists/);
});

test('moving a skill to another plugin rewrites the frontmatter name it is addressed by', async () => {
  ok(await handlePluginsSkillMove(deps(), {
    pluginId: 'alpha', skill: 'review', toPluginId: 'beta', toSkill: 'critique',
  }));

  const { plugins } = await handlePluginsList(deps(), {});
  assert.deepEqual(plugins.find((plugin) => plugin.id === 'alpha')?.skills, []);
  assert.deepEqual(
    plugins.find((plugin) => plugin.id === 'beta')?.skills.map((skill) => skill.name),
    ['critique'],
  );
  assert.match(
    readFileSync(path.join(PLUGINS_DIR, 'beta', 'skills', 'critique', 'SKILL.md'), 'utf8'),
    /^name: critique$/m,
  );
});

test('refuses to move a skill onto an occupied name', async () => {
  ok(await handlePluginsSkillCreate(deps(), {
    pluginId: 'beta', skill: 'review', description: 'other review',
  }));

  const failure = err(await handlePluginsSkillMove(deps(), {
    pluginId: 'alpha', skill: 'review', toPluginId: 'beta', toSkill: 'review',
  }));
  assert.equal(failure.code, 'invalid-args');
  assert.ok(existsSync(path.join(PLUGINS_DIR, 'alpha', 'skills', 'review')));
});

test('removes a skill directory and nothing above it', async () => {
  ok(await handlePluginsSkillRemove(deps(), { pluginId: 'alpha', skill: 'review' }));

  assert.equal(existsSync(path.join(PLUGINS_DIR, 'alpha', 'skills', 'review')), false);
  assert.ok(existsSync(path.join(PLUGINS_DIR, 'alpha', 'plugin.json')));
});

test('creates a portable plugin and refuses a duplicate id', async () => {
  ok(await handlePluginsCreate(deps(), { id: 'gamma', description: 'local pack' }));

  const { plugins } = await handlePluginsList(deps(), {});
  const gamma = plugins.find((plugin) => plugin.id === 'gamma');
  assert.equal(gamma?.kind, 'portable');
  assert.equal(gamma?.valid, true);
  assert.equal(gamma?.origin, 'local');

  assert.equal(err(await handlePluginsCreate(deps(), { id: 'gamma' })).code, 'invalid-args');
});

test('refuses to remove a plugin an agent still points at, and removes it once free', async () => {
  const blocked = err(await handlePluginsRemove(deps(), { id: 'alpha' }));
  assert.match(blocked.message, /still assigned to: writer/);

  ok(await handlePluginsRemove(deps(), { id: 'beta' }));
  assert.equal(existsSync(path.join(PLUGINS_DIR, 'beta')), false);
});

test('gives a legacy plugin a root manifest carrying its legacy version', async () => {
  seedLegacyPlugin('old-pack');

  ok(await handlePluginsConvertToPortable(deps(), { id: 'old-pack' }));

  const manifest = JSON.parse(readFileSync(path.join(PLUGINS_DIR, 'old-pack', 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '2.3.4');
  assert.equal(manifest.$schema, AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL);
  assert.ok(existsSync(path.join(PLUGINS_DIR, 'old-pack', '.claude-plugin', 'plugin.json')));

  const { plugins } = await handlePluginsList(deps(), {});
  assert.equal(plugins.find((plugin) => plugin.id === 'old-pack')?.kind, 'portable');
  assert.equal(err(await handlePluginsConvertToPortable(deps(), { id: 'old-pack' })).code, 'invalid-args');
});

test('mcpRead carries what a form needs and never a secret value', async () => {
  const read = await handlePluginsMcpRead(deps(), { pluginId: 'alpha' });

  assert.equal(read.supported, true);
  assert.deepEqual(read.servers.map((server) => server.name), ['local', 'remote']);
  const serialized = JSON.stringify(read);
  assert.ok(serialized.includes('./bin/server'));
  assert.ok(serialized.includes('SECRET_TOKEN'));
  assert.equal(serialized.includes('super-secret-env'), false);
  assert.equal(serialized.includes('super-secret-header'), false);
});

test('a null secret keeps the value on disk, so an editor never has to hold it', async () => {
  ok(await handlePluginsMcpWrite(deps(), {
    pluginId: 'alpha',
    servers: [
      { name: 'local', type: 'stdio', command: './bin/server', args: ['--quiet'], env: { SECRET_TOKEN: null } },
      { name: 'remote', type: 'streamable-http', url: 'https://api.example.com/v2', headers: { Authorization: null } },
    ],
  }));

  const envelope = JSON.parse(readFileSync(path.join(PLUGINS_DIR, 'alpha', 'mcp.json'), 'utf8'));
  assert.equal(envelope.mcpServers.local.env.SECRET_TOKEN, 'super-secret-env');
  assert.deepEqual(envelope.mcpServers.local.args, ['--quiet']);
  assert.equal(envelope.mcpServers.remote.headers.Authorization, 'Bearer super-secret-header');
  assert.equal(envelope.mcpServers.remote.url, 'https://api.example.com/v2');
});

test('a null secret with nothing stored is refused rather than written as empty', async () => {
  const failure = err(await handlePluginsMcpWrite(deps(), {
    pluginId: 'alpha',
    servers: [{ name: 'local', type: 'stdio', command: './bin/server', env: { NEW_KEY: null } }],
  }));

  assert.equal(failure.code, 'invalid-args');
  assert.match(failure.message, /no stored value to keep/);
});

test('an mcp.json the loader would reject is refused before it reaches disk', async () => {
  const before = readFileSync(path.join(PLUGINS_DIR, 'alpha', 'mcp.json'), 'utf8');

  const failure = err(await handlePluginsMcpWrite(deps(), {
    pluginId: 'alpha',
    servers: [{ name: 'local', type: 'stdio', command: './bin/server', env: { PLUGIN_ROOT: 'x' } }],
  }));

  assert.equal(failure.code, 'invalid-args');
  assert.equal(readFileSync(path.join(PLUGINS_DIR, 'alpha', 'mcp.json'), 'utf8'), before);
});

test('a symlinked skill directory cannot redirect a write outside the plugins root', async () => {
  const outside = path.join(os.tmpdir(), `plugin-escape-${process.pid}`);
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'SKILL.md'), skillMarkdown('escape', 'outside skill'), 'utf8');
  symlinkSync(outside, path.join(PLUGINS_DIR, 'alpha', 'skills', 'escape'), 'dir');

  const failure = err(await handlePluginsSkillWrite(deps(), {
    pluginId: 'alpha', skill: 'escape', content: 'tampered', baseHash: 'x'.repeat(64),
  }));

  assert.equal(failure.code, 'invalid-args');
  assert.match(readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), /outside skill/);
  rmSync(outside, { recursive: true, force: true });
});
