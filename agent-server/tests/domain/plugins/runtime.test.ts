// input:  plugin roots, manifests, runtime resolver
// output: backend projection, MCP, and fingerprint tests
// pos:    Tests the shared plugin runtime resolver
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { AGENT_PLUGIN_V1_MCP_SCHEMA_URL, AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL } from '../../../src/domain/plugins/agent-plugins-v1.js';
import { safeClaudeManifestName, safeNativeComposite } from '../../../src/domain/plugins/native-name.js';
import { resolvePluginRuntime } from '../../../src/domain/plugins/runtime.js';
import { buildProjectedSkillTree, copyProjectedSkillTree } from '../../../src/domain/plugins/skill-projection.js';

interface Harness {
  dataDir: string;
  pluginsDir: string;
  physicalPluginsDir: string;
  runtimeDir: string;
}

interface SkillFixture {
  name: string;
  valid?: boolean;
  files?: Array<{ path: string; content: string; mode?: number }>;
  symlink?: { path: string; target: string; type?: fs.symlink.Type };
}

interface PortablePluginOptions {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  skills?: SkillFixture[];
  mcpServers?: Record<string, unknown>;
}

const cleanup: string[] = [];

afterEach(() => {
  cleanup.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }));
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeHarness(options: { symlinkPluginsDir?: boolean } = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-plugin-runtime-'));
  cleanup.push(dataDir);
  const runtimeDir = path.join(dataDir, 'data', 'plugin-runtime');
  if (options.symlinkPluginsDir) {
    const physicalPluginsDir = path.join(dataDir, 'plugin-storage');
    fs.mkdirSync(physicalPluginsDir, { recursive: true });
    const pluginsDir = path.join(dataDir, 'plugins');
    fs.symlinkSync(physicalPluginsDir, pluginsDir, 'dir');
    return { dataDir, pluginsDir, physicalPluginsDir, runtimeDir };
  }
  const pluginsDir = path.join(dataDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  return { dataDir, pluginsDir, physicalPluginsDir: pluginsDir, runtimeDir };
}

function skillText(name: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} helper skill.`,
    '---',
    `# ${name}`,
    '',
  ].join('\n');
}

function writePortableManifest(root: string, options: PortablePluginOptions): void {
  writeJson(path.join(root, 'plugin.json'), {
    $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
    name: options.name ?? options.id,
    ...(options.version ? { version: options.version } : {}),
    ...(options.description ? { description: options.description } : {}),
  });
}

function writeSkillFixtureFile(skillDir: string, file: NonNullable<SkillFixture['files']>[number]): void {
  const target = path.join(skillDir, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file.content);
  if (file.mode) fs.chmodSync(target, file.mode);
}

function writeSkillFixture(root: string, skill: SkillFixture): void {
  const skillDir = path.join(root, 'skills', skill.name);
  fs.mkdirSync(skillDir, { recursive: true });
  const content = skill.valid === false ? '# invalid skill\n' : skillText(skill.name);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
  for (const file of skill.files ?? []) writeSkillFixtureFile(skillDir, file);
  if (!skill.symlink) return;
  const link = path.join(skillDir, skill.symlink.path);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(skill.symlink.target, link, skill.symlink.type ?? 'dir');
}

function portablePlugin(harness: Harness, options: PortablePluginOptions): string {
  const root = path.join(harness.physicalPluginsDir, options.id);
  fs.mkdirSync(root, { recursive: true });
  writePortableManifest(root, options);
  for (const skill of options.skills ?? []) writeSkillFixture(root, skill);
  if (options.mcpServers) {
    writeJson(path.join(root, 'mcp.json'), {
      $schema: AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
      mcpServers: options.mcpServers,
    });
  }
  return root;
}

function invalidPortablePlugin(harness: Harness, id: string): string {
  const root = path.join(harness.physicalPluginsDir, id);
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'plugin.json'), {
    $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
    name: 'Bad Plugin Name',
  });
  return root;
}

function legacyPlugin(harness: Harness, id: string): string {
  const root = path.join(harness.physicalPluginsDir, id);
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeJson(path.join(root, '.claude-plugin', 'plugin.json'), { name: id, version: '1.0.0' });
  return root;
}

function unmanagedRoot(harness: Harness, name: string): string {
  const root = path.join(harness.dataDir, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function resolveRuntime(
  harness: Harness,
  selectedPluginDirs: string[],
  options: { backend?: 'claude' | 'pi'; mcpComposition?: 'direct' | 'thread-control' | 'none' | 'benchmark-thread-run' } = {},
) {
  return resolvePluginRuntime({
    backend: options.backend ?? 'claude',
    selectedPluginDirs,
    mcpComposition: options.mcpComposition ?? 'direct',
    dataDir: harness.dataDir,
    pluginsDir: harness.pluginsDir,
    runtimeDir: harness.runtimeDir,
  });
}

function createPrivateMcpPlugin(harness: Harness): void {
  portablePlugin(harness, {
    id: 'portable-mcp',
    skills: [{ name: 'mcp-skill' }],
    mcpServers: {
      cmd: {
        type: 'stdio',
        command: './bin/private-launch',
        args: ['--token', 'secret-arg'],
        env: { API_KEY: 'secret-env' },
        cwd: '${PLUGIN_ROOT}',
      },
      http: {
        type: 'streamable-http',
        url: 'https://private.example.com/mcp',
        headers: { Authorization: 'Bearer secret-http' },
      },
      sse: {
        type: 'sse',
        url: 'https://private.example.com/events',
        headers: { 'X-Secret': 'secret-sse' },
      },
    },
  });
}

function expectedPrivateStdio(harness: Harness) {
  return {
    name: safeNativeComposite(['portable-mcp', 'cmd'], 'plugin'),
    type: 'stdio' as const,
    command: path.join(harness.physicalPluginsDir, 'portable-mcp', 'bin', 'private-launch'),
    args: ['--token', 'secret-arg'],
    env: {
      API_KEY: 'secret-env',
      PLUGIN_ROOT: path.join(harness.physicalPluginsDir, 'portable-mcp'),
      PLUGIN_DATA: path.join(harness.dataDir, 'data', 'plugin-data', 'portable-mcp'),
    },
    cwd: path.join(harness.physicalPluginsDir, 'portable-mcp'),
  };
}

function expectedPrivateRemotes() {
  return [
    {
      name: safeNativeComposite(['portable-mcp', 'http'], 'plugin'),
      type: 'streamable-http',
      url: 'https://private.example.com/mcp',
      headers: { Authorization: 'Bearer secret-http' },
    },
    {
      name: safeNativeComposite(['portable-mcp', 'sse'], 'plugin'),
      type: 'sse',
      url: 'https://private.example.com/events',
      headers: { 'X-Secret': 'secret-sse' },
    },
  ];
}

function createClaudeProjectionPlugin(harness: Harness): void {
  portablePlugin(harness, {
    id: 'portable-claude',
    name: '9portable.plugin',
    version: '2.0.0+Portable%Build',
    description: 'Portable Claude projection.',
    skills: [
      {
        name: 'valid-skill',
        files: [
          { path: 'assets/prompt.txt', content: 'asset\n' },
          { path: 'bin/run.sh', content: '#!/bin/sh\necho ok\n', mode: 0o755 },
        ],
      },
      { name: 'invalid-skill', valid: false },
    ],
    mcpServers: {
      hidden: { type: 'sse', url: 'https://hidden.example.com/sse' },
    },
  });
}

function createPluginDataFixtures(harness: Harness): void {
  portablePlugin(harness, {
    id: 'portable-env',
    skills: [{ name: 'env-skill' }],
    mcpServers: {
      run: {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_DATA}/cache', '${PLUGIN_ROOT}/bin/server'],
        env: { CUSTOM: 'ok' },
        cwd: '${PLUGIN_DATA}',
      },
    },
  });
  portablePlugin(harness, {
    id: 'portable-unselected',
    skills: [{ name: 'other-skill' }],
    mcpServers: {
      run: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}' },
    },
  });
}

test('resolves relative, absolute, and realpath aliases once with a deterministic fingerprint', () => {
  const harness = makeHarness({ symlinkPluginsDir: true });
  const pluginRoot = portablePlugin(harness, {
    id: 'portable-alpha',
    skills: [{ name: 'alpha-skill' }],
    mcpServers: {
      alpha: { type: 'streamable-http', url: 'https://alpha.example.com/mcp' },
    },
  });

  const relative = 'plugins/portable-alpha';
  const absoluteViaSymlink = path.join(harness.pluginsDir, 'portable-alpha');
  const real = fs.realpathSync(pluginRoot);

  const one = resolveRuntime(harness, [relative], { backend: 'claude' });
  const aliases = resolveRuntime(harness, [relative, absoluteViaSymlink, real], { backend: 'claude' });

  assert.equal(aliases.pluginCapabilityFingerprint, one.pluginCapabilityFingerprint);
  assert.deepEqual(aliases.pluginDirs, one.pluginDirs);
  assert.deepEqual(aliases.mcpServers, one.mcpServers);
  assert.equal(aliases.pluginDirs?.length, 1);
  assert.equal(aliases.mcpServers?.length, 1);
});

test('returns selected portable plugins only', () => {
  const harness = makeHarness();
  portablePlugin(harness, {
    id: 'portable-selected',
    skills: [{ name: 'selected-skill' }],
    mcpServers: { selected: { type: 'sse', url: 'https://selected.example.com/sse' } },
  });
  portablePlugin(harness, {
    id: 'portable-unselected',
    skills: [{ name: 'ignored-skill' }],
    mcpServers: { ignored: { type: 'sse', url: 'https://ignored.example.com/sse' } },
  });

  const resolved = resolveRuntime(harness, ['plugins/portable-selected'], { backend: 'pi' });

  assert.deepEqual(resolved.pluginSkillDirs?.map((dir) => path.basename(dir)).sort(), ['selected-skill']);
  assert.deepEqual(resolved.mcpServers?.map((server) => server.name), [
    safeNativeComposite(['portable-selected', 'selected'], 'plugin'),
  ]);
});

test('preserves private stdio, streamable-http, and sse MCP runtime values', () => {
  const harness = makeHarness();
  createPrivateMcpPlugin(harness);

  const resolved = resolveRuntime(harness, ['plugins/portable-mcp'], { backend: 'pi' });

  assert.deepEqual(resolved.mcpServers, [
    expectedPrivateStdio(harness),
    ...expectedPrivateRemotes(),
  ]);
});

test('portable runtime names stay distinct across pair-boundary collisions', () => {
  const harness = makeHarness();
  portablePlugin(harness, {
    id: 'portable-a',
    skills: [{ name: 'alpha-skill' }],
    mcpServers: { b_c: { type: 'sse', url: 'https://one.example.com/sse' } },
  });
  portablePlugin(harness, {
    id: 'portable-a-b',
    skills: [{ name: 'beta-skill' }],
    mcpServers: { c: { type: 'sse', url: 'https://two.example.com/sse' } },
  });

  const resolved = resolveRuntime(harness, ['plugins/portable-a', 'plugins/portable-a-b'], { backend: 'pi' });
  assert.deepEqual(resolved.mcpServers?.map((server) => server.name), [
    safeNativeComposite(['portable-a', 'b_c'], 'plugin'),
    safeNativeComposite(['portable-a-b', 'c'], 'plugin'),
  ]);
  assert.notEqual(resolved.mcpServers?.[0]?.name, resolved.mcpServers?.[1]?.name);
});

test('rejects duplicate portable skill names', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-one', skills: [{ name: 'shared-skill' }] });
  portablePlugin(harness, { id: 'portable-two', skills: [{ name: 'shared-skill' }] });

  assert.throws(
    () => resolveRuntime(harness, ['plugins/portable-one', 'plugins/portable-two']),
    /Duplicate portable skill name: shared-skill/,
  );
});

test('rejects duplicate portable MCP namespaces', () => {
  const harness = makeHarness();
  portablePlugin(harness, {
    id: 'portable-one',
    name: 'shared.namespace',
    mcpServers: { first: { type: 'sse', url: 'https://one.example.com/sse' } },
  });
  portablePlugin(harness, {
    id: 'portable-two',
    name: 'shared.namespace',
    mcpServers: { second: { type: 'sse', url: 'https://two.example.com/sse' } },
  });

  assert.throws(
    () => resolveRuntime(harness, ['plugins/portable-one', 'plugins/portable-two']),
    /Duplicate portable MCP namespace:/,
  );
});

test('rejects duplicate portable namespaces even when no MCP servers are declared', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-one', name: 'shared.namespace' });
  portablePlugin(harness, { id: 'portable-two', name: 'shared.namespace' });

  assert.throws(
    () => resolveRuntime(harness, ['plugins/portable-one', 'plugins/portable-two']),
    /Duplicate portable MCP namespace:/,
  );
});

test('fails closed when an assigned portable package is invalid', () => {
  const harness = makeHarness();
  invalidPortablePlugin(harness, 'portable-invalid');

  assert.throws(
    () => resolveRuntime(harness, ['plugins/portable-invalid']),
    /Assigned portable plugin 'portable-invalid' is invalid/,
  );
});

test('Claude projection copies validated skill trees, preserves executable files, and normalizes manifest compatibility fields', () => {
  const harness = makeHarness();
  createClaudeProjectionPlugin(harness);

  const resolved = resolveRuntime(harness, ['plugins/portable-claude'], { backend: 'claude' });
  const projection = resolved.pluginDirs?.[0];
  assert.ok(projection, 'expected a Claude projection');

  const mode = fs.statSync(projection).mode & 0o777;
  assert.equal(mode, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projection, '.claude-plugin', 'plugin.json'), 'utf8')), {
    name: safeClaudeManifestName('9portable.plugin'),
    version: '2.0.0-portable-build',
    description: 'Portable Claude projection.',
  });
  assert.equal(fs.existsSync(path.join(projection, 'mcp.json')), false, 'projection must not expose native MCP');
  assert.equal(fs.existsSync(path.join(projection, 'skills', 'invalid-skill')), false);
  assert.equal(fs.lstatSync(path.join(projection, 'skills', 'valid-skill')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(projection, 'skills', 'valid-skill', 'assets', 'prompt.txt'), 'utf8'), 'asset\n');
  assert.equal(fs.readFileSync(path.join(projection, 'skills', 'valid-skill', 'bin', 'run.sh'), 'utf8'), '#!/bin/sh\necho ok\n');
  assert.equal(fs.statSync(path.join(projection, 'skills', 'valid-skill', 'bin', 'run.sh')).mode & 0o111, 0o111);
});

test('isolates a tampered Claude projection while preserving portable MCP', () => {
  const harness = makeHarness();
  portablePlugin(harness, {
    id: 'portable-manifest-race', version: '1.0.0',
    skills: [{ name: 'race-skill' }],
    mcpServers: { remote: { type: 'sse', url: 'https://safe.example/sse' } },
  });
  const first = resolveRuntime(harness, ['plugins/portable-manifest-race'], { backend: 'claude' });
  const projection = first.pluginDirs?.[0];
  assert.ok(projection, 'expected a Claude projection');
  fs.writeFileSync(path.join(projection, '.claude-plugin', 'plugin.json'), '{"name":"tampered"}\n');

  const second = resolveRuntime(harness, ['plugins/portable-manifest-race'], { backend: 'claude' });

  assert.equal(second.pluginDirs, undefined);
  assert.equal(second.mcpServers?.length, 1);
});

test('removes only a newly created Claude projection target when post-rename validation fails', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-post-rename', skills: [{ name: 'race-skill' }] });
  const fsRenameSync = fs.renameSync;
  const createdTargets: string[] = [];
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    fsRenameSync(from, to);
    const target = String(to);
    if (target.includes('skill-snapshots')) return;
    createdTargets.push(target);
    fs.writeFileSync(path.join(target, '.mcp.json'), '{}\n');
  }) as typeof fs.renameSync;
  try {
    const resolved = resolveRuntime(harness, ['plugins/portable-post-rename'], { backend: 'claude' });
    assert.equal(resolved.pluginDirs, undefined);
  } finally {
    fs.renameSync = fsRenameSync;
  }

  assert.equal(createdTargets.length, 1);
  assert.equal(fs.existsSync(createdTargets[0]), false);
});

test('fails closed when a pre-existing Claude projection skill content is tampered', () => {
  const harness = makeHarness();
  portablePlugin(harness, {
    id: 'portable-symlink-race',
    skills: [{ name: 'race-skill', files: [{ path: 'asset.txt', content: 'ok\n' }] }],
  });

  const first = resolveRuntime(harness, ['plugins/portable-symlink-race'], { backend: 'claude' });
  const projection = first.pluginDirs?.[0];
  assert.ok(projection, 'expected a Claude projection');
  fs.writeFileSync(path.join(projection, 'skills', 'race-skill', 'asset.txt'), 'tampered\n');

  const second = resolveRuntime(harness, ['plugins/portable-symlink-race'], { backend: 'claude' });
  assert.equal(second.pluginDirs, undefined);
  assert.equal(fs.existsSync(projection), true);
});

test('returns backend-specific skill and plugin paths for portable, legacy, and unmanaged roots', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-backend', skills: [{ name: 'portable-skill' }] });
  legacyPlugin(harness, 'legacy-backend');
  const unmanaged = unmanagedRoot(harness, 'unmanaged-backend');

  const selected = ['plugins/portable-backend', 'plugins/legacy-backend', unmanaged];
  const claude = resolveRuntime(harness, selected, { backend: 'claude' });
  const pi = resolveRuntime(harness, selected, { backend: 'pi' });

  assert.equal(claude.pluginDirs?.length, 3);
  assert.ok(claude.pluginDirs?.[0].includes(path.join('plugin-runtime', 'claude')));
  assert.deepEqual(claude.pluginDirs?.slice(1), [
    fs.realpathSync(path.join(harness.pluginsDir, 'legacy-backend')),
    fs.realpathSync(unmanaged),
  ]);
  assert.equal(pi.pluginSkillDirs?.length, 1);
  assert.ok(pi.pluginSkillDirs?.[0].includes(path.join('plugin-runtime', 'pi')));
  assert.equal(fs.lstatSync(pi.pluginSkillDirs?.[0] ?? '').isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(pi.pluginSkillDirs?.[0] ?? '', 'SKILL.md'), 'utf8'), skillText('portable-skill'));
  assert.deepEqual(pi.pluginDirs, [
    fs.realpathSync(path.join(harness.pluginsDir, 'legacy-backend')),
    fs.realpathSync(unmanaged),
  ]);
  assert.notEqual(claude.pluginCapabilityFingerprint, pi.pluginCapabilityFingerprint);
});

test('capability fingerprint preserves selected plugin order', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-one', skills: [{ name: 'one-skill' }] });
  portablePlugin(harness, { id: 'portable-two', skills: [{ name: 'two-skill' }] });

  const forward = resolveRuntime(harness, ['plugins/portable-one', 'plugins/portable-two'], {
    backend: 'pi',
  });
  const reverse = resolveRuntime(harness, ['plugins/portable-two', 'plugins/portable-one'], {
    backend: 'pi',
  });

  assert.notEqual(forward.pluginCapabilityFingerprint, reverse.pluginCapabilityFingerprint);
});

test('capability fingerprint changes when validated SKILL.md bytes change', () => {
  const harness = makeHarness();
  const pluginRoot = portablePlugin(harness, {
    id: 'portable-hash',
    skills: [{ name: 'portable-skill' }],
  });

  const before = resolveRuntime(harness, ['plugins/portable-hash'], { backend: 'claude' });
  fs.writeFileSync(path.join(pluginRoot, 'skills', 'portable-skill', 'SKILL.md'), [
    '---',
    'name: portable-skill',
    'description: Updated validated content.',
    '---',
    '# portable-skill',
    '',
  ].join('\n'));
  const after = resolveRuntime(harness, ['plugins/portable-hash'], { backend: 'claude' });

  assert.notEqual(before.pluginCapabilityFingerprint, after.pluginCapabilityFingerprint);
});

test('rejects collisions between selected managed legacy skills and portable skills', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-skill', skills: [{ name: 'shared-skill' }] });
  const legacyRoot = legacyPlugin(harness, 'legacy-skill');
  const legacySkillDir = path.join(legacyRoot, 'skills', 'shared-skill');
  fs.mkdirSync(legacySkillDir, { recursive: true });
  fs.writeFileSync(path.join(legacySkillDir, 'SKILL.md'), '# legacy skill\n');

  assert.throws(
    () => resolveRuntime(harness, ['plugins/portable-skill', 'plugins/legacy-skill']),
    /Duplicate portable skill name: shared-skill/,
  );
});

test('portable stdio runtime creates writable PLUGIN_DATA only for selected plugins', () => {
  const harness = makeHarness();
  createPluginDataFixtures(harness);
  const selectedData = path.join(harness.dataDir, 'data', 'plugin-data', 'portable-env');
  const unselectedData = path.join(harness.dataDir, 'data', 'plugin-data', 'portable-unselected');
  assert.equal(fs.existsSync(selectedData), false);
  assert.equal(fs.existsSync(unselectedData), false);

  const resolved = resolveRuntime(harness, ['plugins/portable-env'], { backend: 'pi' });
  const server = resolved.mcpServers?.[0];
  assert.ok(server && server.type === 'stdio');
  assert.equal(server.cwd, selectedData);
  assert.equal(server.env.PLUGIN_ROOT, path.join(harness.physicalPluginsDir, 'portable-env'));
  assert.equal(server.env.PLUGIN_DATA, selectedData);
  assert.equal(server.args[0], path.join(selectedData, 'cache'));
  assert.equal(fs.statSync(selectedData).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(unselectedData), false);
  fs.writeFileSync(path.join(server.env.PLUGIN_DATA, 'probe.txt'), 'ok\n');
  assert.equal(fs.readFileSync(path.join(server.env.PLUGIN_DATA, 'probe.txt'), 'utf8'), 'ok\n');
});

test('copyProjectedSkillTree rechecks each source realpath before read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-skill-copy-race-'));
  cleanup.push(root);
  const packageRoot = path.join(root, 'package');
  const skillRoot = path.join(packageRoot, 'skills', 'race-skill');
  const inside = path.join(packageRoot, 'inside.txt');
  const outside = path.join(root, 'outside.txt');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(inside, 'inside\n');
  fs.writeFileSync(outside, 'outside\n');
  fs.symlinkSync(inside, path.join(skillRoot, 'asset.txt'), 'file');

  const tree = buildProjectedSkillTree(packageRoot, skillRoot);
  fs.rmSync(path.join(skillRoot, 'asset.txt'));
  fs.symlinkSync(outside, path.join(skillRoot, 'asset.txt'), 'file');

  assert.throws(
    () => copyProjectedSkillTree(packageRoot, skillRoot, tree, targetRoot),
    /escapes plugin root/i,
  );
  assert.equal(fs.existsSync(path.join(targetRoot, 'asset.txt')), false);
});

test('copyProjectedSkillTree rejects a file swapped after source realpath resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-skill-open-race-'));
  cleanup.push(root);
  const packageRoot = path.join(root, 'package');
  const skillRoot = path.join(packageRoot, 'skills', 'race-skill');
  const source = path.join(skillRoot, 'asset.txt');
  const outside = path.join(root, 'outside.txt');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(source, 'inside\n');
  fs.writeFileSync(outside, 'outside\n');
  const tree = buildProjectedSkillTree(packageRoot, skillRoot);
  const openSync = fs.openSync;
  fs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (String(filePath) === source) {
      fs.rmSync(source);
      fs.symlinkSync(outside, source, 'file');
    }
    return openSync(filePath, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.throws(() => copyProjectedSkillTree(packageRoot, skillRoot, tree, targetRoot));
    assert.equal(fs.existsSync(path.join(targetRoot, 'asset.txt')), false);
  } finally {
    fs.openSync = openSync;
  }
});

test('isolates an escaping skill tree from valid MCP in the same plugin', () => {
  const harness = makeHarness();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-skill-escape-'));
  cleanup.push(outside);
  portablePlugin(harness, {
    id: 'portable-escape',
    skills: [{ name: 'escape-skill', symlink: { path: 'bin/escape', target: outside, type: 'dir' } }],
    mcpServers: { remote: { type: 'sse', url: 'https://safe.example/sse' } },
  });

  const resolved = resolveRuntime(harness, ['plugins/portable-escape'], { backend: 'claude' });

  assert.equal(resolved.pluginDirs, undefined);
  assert.equal(resolved.mcpServers?.length, 1);
});

test('isolates a failed skill snapshot from a valid sibling skill and MCP', () => {
  const harness = makeHarness();
  portablePlugin(harness, {
    id: 'portable-skill-sibling',
    skills: [{ name: 'bad-skill' }, { name: 'good-skill' }],
    mcpServers: { remote: { type: 'sse', url: 'https://safe.example/sse' } },
  });
  const first = resolveRuntime(harness, ['plugins/portable-skill-sibling'], { backend: 'pi' });
  const bad = first.pluginSkillDirs?.find((dir) => fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').includes('bad-skill'));
  assert.ok(bad);
  fs.writeFileSync(path.join(bad, 'SKILL.md'), 'tampered\n');

  const second = resolveRuntime(harness, ['plugins/portable-skill-sibling'], { backend: 'pi' });

  assert.equal(second.pluginSkillDirs?.length, 1);
  assert.match(fs.readFileSync(path.join(second.pluginSkillDirs?.[0] ?? '', 'SKILL.md'), 'utf8'), /good-skill/);
  assert.equal(second.mcpServers?.length, 1);
});

test('isolates shared plugin-data failure from remote MCP and skills', () => {
  const harness = makeHarness();
  portablePlugin(harness, {
    id: 'portable-data-failure', skills: [{ name: 'safe-skill' }],
    mcpServers: {
      localA: { type: 'stdio', command: 'node' },
      localB: { type: 'stdio', command: 'node' },
      remote: { type: 'sse', url: 'https://safe.example/sse' },
    },
  });
  const selectedData = path.join(harness.dataDir, 'data', 'plugin-data', 'portable-data-failure');
  const mkdirSync = fs.mkdirSync;
  fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    if (path.resolve(String(target)) === selectedData) throw new Error('data denied');
    return mkdirSync(target, options as never);
  }) as typeof fs.mkdirSync;
  try {
    const resolved = resolveRuntime(harness, ['plugins/portable-data-failure'], { backend: 'pi' });
    assert.deepEqual(resolved.mcpServers?.map((server) => server.name), [
      safeNativeComposite(['portable-data-failure', 'remote'], 'plugin'),
    ]);
    assert.equal(resolved.pluginSkillDirs?.length, 1);
  } finally {
    fs.mkdirSync = mkdirSync;
  }
});

test('fails closed when a pre-existing Claude projection contains unknown root entries', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-root-tamper', skills: [{ name: 'race-skill' }] });
  const first = resolveRuntime(harness, ['plugins/portable-root-tamper'], { backend: 'claude' });
  const projection = first.pluginDirs?.[0];
  assert.ok(projection);
  fs.writeFileSync(path.join(projection, '.mcp.json'), '{}\n');

  const second = resolveRuntime(harness, ['plugins/portable-root-tamper'], { backend: 'claude' });
  assert.equal(second.pluginDirs, undefined);
});

test('rejects symlinked runtimeDir ancestry before writing a Claude projection', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-symlinked-runtime', skills: [{ name: 'race-skill' }] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-runtime-symlink-'));
  cleanup.push(root);
  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(physical, { recursive: true });
  fs.symlinkSync(physical, alias, 'dir');

  const resolved = resolvePluginRuntime({
    backend: 'claude',
    selectedPluginDirs: ['plugins/portable-symlinked-runtime'],
    mcpComposition: 'direct',
    dataDir: harness.dataDir,
    pluginsDir: harness.pluginsDir,
    runtimeDir: path.join(alias, 'plugin-runtime'),
  });
  assert.equal(resolved.pluginDirs, undefined);
  assert.equal(fs.existsSync(path.join(physical, 'plugin-runtime', 'claude')), false);
});

test('Claude projection temp and final basenames stay bounded for long plugin ids', () => {
  const harness = makeHarness();
  const id = `portable-${'x'.repeat(180)}`;
  portablePlugin(harness, {
    id,
    name: 'portable-long-id',
    skills: [{ name: 'race-skill' }],
  });
  const renameSync = fs.renameSync;
  const seen: Array<{ from: string; to: string }> = [];
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    seen.push({ from: path.basename(String(from)), to: path.basename(String(to)) });
    renameSync(from, to);
  }) as typeof fs.renameSync;
  try {
    const resolved = resolveRuntime(harness, [`plugins/${id}`], { backend: 'claude' });
    assert.ok(resolved.pluginDirs?.[0]);
  } finally {
    fs.renameSync = renameSync;
  }

  assert.equal(seen.length, 2);
  for (const item of seen) {
    assert.ok(item.from.length <= 64, item.from);
    assert.ok(item.to.length <= 64, item.to);
  }
});

test('fails closed when a pre-existing Claude projection manifest directory contains extra entries', () => {
  const harness = makeHarness();
  portablePlugin(harness, { id: 'portable-manifest-extra', skills: [{ name: 'race-skill' }] });
  const first = resolveRuntime(harness, ['plugins/portable-manifest-extra'], { backend: 'claude' });
  const projection = first.pluginDirs?.[0];
  assert.ok(projection);
  fs.mkdirSync(path.join(projection, '.claude-plugin', 'hooks'));

  const second = resolveRuntime(harness, ['plugins/portable-manifest-extra'], { backend: 'claude' });
  assert.equal(second.pluginDirs, undefined);
});

test('suppresses portable MCP for restricted compositions only', () => {
  const harness = makeHarness();
  portablePlugin(harness, {
    id: 'portable-restricted',
    skills: [{ name: 'restricted-skill' }],
    mcpServers: { restricted: { type: 'sse', url: 'https://restricted.example.com/sse' } },
  });

  const direct = resolveRuntime(harness, ['plugins/portable-restricted'], {
    backend: 'pi',
    mcpComposition: 'direct',
  });
  const none = resolveRuntime(harness, ['plugins/portable-restricted'], {
    backend: 'pi',
    mcpComposition: 'none',
  });
  const benchmark = resolveRuntime(harness, ['plugins/portable-restricted'], {
    backend: 'pi',
    mcpComposition: 'benchmark-thread-run',
  });

  assert.equal(direct.mcpServers?.length, 1);
  assert.equal(none.mcpServers, undefined);
  assert.equal(benchmark.mcpServers, undefined);
});
