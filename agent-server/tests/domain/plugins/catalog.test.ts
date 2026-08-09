// input:  isolated roots, schemas, catalog loaders
// output: plugin catalog regression coverage
// pos:    Tests catalog discovery and containment
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
  AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
  portableManifestSchema,
  portableMcpSchema,
  portableMcpServerSchema,
} from '../../../src/domain/plugins/agent-plugins-v1.js';
import { loadPluginCatalog } from '../../../src/domain/plugins/catalog.js';

type CatalogEntry = ReturnType<typeof loadPluginCatalog>[number];
type McpServer = CatalogEntry['mcp']['servers'][number];

const homeRoot = process.env.CORTEX_HOME ?? '';
const pluginsRoot = path.join(homeRoot, 'plugins');
const pluginDataRoot = path.join(homeRoot, 'data', 'plugin-data');
const schemaRoot = path.join(
  process.cwd(),
  'src',
  'domain',
  'plugins',
  'resources',
  '1.0.0',
);
const defaultsPluginsRoot = path.join(process.cwd(), 'defaults', 'plugins');
const cleanup: string[] = [];

const OFFICIAL_PLUGIN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
  title: 'Agent Plugins Manifest',
  description: 'Machine-readable schema for plugin.json in Agent Plugins 1.0.0. The Agent Plugins specification defines additional semantic and operational requirements.',
  type: 'object',
  properties: {
    $schema: {
      const: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
      description: 'Canonical identifier of the plugin manifest schema for the Agent Plugins version targeted by this document.',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$',
      description: 'Human-readable plugin name.',
    },
    version: { type: 'string' },
    description: { type: 'string' },
    author: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
    homepage: { type: 'string' },
    repository: { type: 'string' },
    license: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    extensions: {
      type: 'object',
      description: 'Client-specific manifest data keyed by reverse-domain extension namespace. Agent Plugins assigns no semantics to namespace object contents.',
      additionalProperties: { type: 'object' },
    },
  },
  required: ['$schema', 'name'],
  additionalProperties: false,
};

const OFFICIAL_MCP_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
  title: 'Agent Plugins MCP Configuration',
  description: 'Machine-readable schema for mcp.json in Agent Plugins 1.0.0. The Agent Plugins specification defines additional semantic and operational requirements.',
  type: 'object',
  properties: {
    $schema: {
      const: AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
      description: 'Canonical identifier of the MCP configuration schema for the Agent Plugins version targeted by this document.',
    },
    mcpServers: {
      type: 'object',
      additionalProperties: { $ref: '#/$defs/server' },
    },
  },
  required: ['$schema', 'mcpServers'],
  additionalProperties: false,
  $defs: {
    server: {
      title: 'MCP server',
      oneOf: [
        { $ref: '#/$defs/stdioServer' },
        { $ref: '#/$defs/streamableHttpServer' },
        { $ref: '#/$defs/sseServer' },
      ],
    },
    stdioServer: {
      title: 'stdio MCP server',
      type: 'object',
      properties: {
        type: { const: 'stdio' },
        command: {
          type: 'string',
          minLength: 1,
          description: 'Executable token. Resolution rules are defined by the Agent Plugins specification.',
        },
        args: { type: 'array', items: { type: 'string' } },
        env: {
          type: 'object',
          propertyNames: { not: { enum: ['PLUGIN_ROOT', 'PLUGIN_DATA'] } },
          additionalProperties: { type: 'string' },
        },
        cwd: {
          type: 'string',
          pattern: '^(?:\\./|\\$\\{PLUGIN_ROOT\\}(?:/|$)|\\$\\{PLUGIN_DATA\\}(?:/|$))',
          description: 'Plugin-relative, PLUGIN_ROOT-rooted, or PLUGIN_DATA-rooted working directory. Filesystem containment is validated separately.',
        },
      },
      required: ['type', 'command'],
      additionalProperties: false,
    },
    streamableHttpServer: {
      title: 'Streamable HTTP MCP server',
      type: 'object',
      properties: {
        type: { const: 'streamable-http' },
        url: {
          type: 'string',
          minLength: 1,
          description: 'MCP endpoint URL. URL semantics are defined by the Agent Plugins specification.',
        },
        headers: { $ref: '#/$defs/headers' },
      },
      required: ['type', 'url'],
      additionalProperties: false,
    },
    sseServer: {
      title: 'Legacy HTTP+SSE MCP server',
      type: 'object',
      properties: {
        type: { const: 'sse' },
        url: {
          type: 'string',
          minLength: 1,
          description: 'MCP endpoint URL. URL semantics are defined by the Agent Plugins specification.',
        },
        headers: { $ref: '#/$defs/headers' },
      },
      required: ['type', 'url'],
      additionalProperties: false,
    },
    headers: {
      title: 'HTTP headers',
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
};

const OFFICIAL_VALID_MANIFEST = {
  $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
  name: 'minimal-plugin',
};

const OFFICIAL_INVALID_MANIFEST = {
  $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
  name: 'My-Plugin',
};

const OFFICIAL_VALID_MCP = {
  $schema: AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
  mcpServers: {
    'local-validator': {
      type: 'stdio',
      command: './bin/validator',
      args: ['--data', '${PLUGIN_DATA}/validator'],
      env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
      cwd: '${PLUGIN_ROOT}',
    },
    'deployment-api': {
      type: 'streamable-http',
      url: 'https://deploy.example.com/mcp',
      headers: { 'X-Tenant': 'public-tenant' },
    },
    'legacy-events': {
      type: 'sse',
      url: 'https://legacy.example.com/sse',
    },
  },
};

const OFFICIAL_INVALID_STDIO = {
  type: 'stdio',
  command: '../bin/server',
  cwd: 'data',
};

const OPTIONAL_SKILL_MESSAGES = [
  'SKILL.md frontmatter license must be a string when present',
  'SKILL.md frontmatter compatibility must be 1-500 characters when present',
  'SKILL.md frontmatter metadata must be a string-to-string map when present',
  'SKILL.md frontmatter allowed-tools must be a string when present',
  'SKILL.md frontmatter contains unknown fields: category',
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }));
});

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function makePlugin(id: string): string {
  const dir = path.join(pluginsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

function skillText(
  name: string,
  options: { description?: string; extra?: string[] } = {},
): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${options.description ?? `${name} helper skill.`}`,
    ...(options.extra ?? []),
    '---',
    `# ${name}`,
    '',
  ].join('\n');
}

function legacySkillText(name: string): string {
  return skillText(name, {
    description: `${name} legacy helper skill.`,
    extra: [
      'author: Cortex',
      'version: 1.0.0',
      'allowed-tools:',
      '  - Read',
      '  - Write',
      '  - Bash',
      'argument-hint: "[task summary]"',
      'date: 2026-07-31',
    ],
  });
}

function makeSkill(pluginDir: string, name: string, content = skillText(name)) {
  const skillDir = path.join(pluginDir, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
}

function writePortableManifest(pluginDir: string, value = OFFICIAL_VALID_MANIFEST) {
  writeJson(path.join(pluginDir, 'plugin.json'), value);
}

function writeMcp(pluginDir: string, mcpServers: Record<string, unknown>) {
  writeJson(path.join(pluginDir, 'mcp.json'), {
    $schema: AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
    mcpServers,
  });
}

function issueCodes(entry: CatalogEntry): string[] {
  return entry.issues.map((issue) => issue.code).sort();
}

function issueMessages(entry: CatalogEntry, code?: string): string[] {
  return entry.issues
    .filter((issue) => code ? issue.code === code : true)
    .map((issue) => issue.message)
    .sort();
}

function runtimeFor(server: McpServer | undefined): any {
  if (!server) return null;
  const symbol = Object.getOwnPropertySymbols(server)[0];
  return symbol ? (server as any)[symbol] : null;
}

function pickPlugin(catalog: CatalogEntry[], id: string): CatalogEntry {
  const entry = catalog.find((item) => item.id === id);
  assert.ok(entry, `missing plugin ${id}`);
  return entry;
}

function loadEntry(id: string, options: { pluginsDir?: string; dataDir?: string } = {}): CatalogEntry {
  return pickPlugin(loadPluginCatalog(options), id);
}

function pickServer(entry: CatalogEntry, name: string): McpServer {
  const server = entry.mcp.servers.find((item) => item.name === name);
  assert.ok(server, `missing MCP server ${name}`);
  return server;
}

function readVendored(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(schemaRoot, name), 'utf8'));
}

function outsideDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function makeRootFixture(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(root);
  return {
    root,
    pluginsDir: path.join(root, 'plugins'),
    dataDir: path.join(root, 'data-home'),
  };
}

function createPortableAlpha(): CatalogEntry {
  const pluginDir = makePlugin('portable-alpha');
  writePortableManifest(pluginDir);
  writeMcp(pluginDir, {
    'deployment-api': {
      type: 'streamable-http',
      url: 'http://[::1]:3000/mcp?token=secret',
      headers: { 'X-Tenant': 'public-tenant' },
    },
    'local-validator': {
      type: 'stdio',
      command: './bin/validator',
      args: ['--data', '${PLUGIN_DATA}/validator', '${UNKNOWN_TOKEN}'],
      env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
      cwd: '${PLUGIN_ROOT}',
    },
  });
  makeSkill(pluginDir, 'summarize', skillText('summarize', {
    description: 'Summarize plugin output when asked.',
  }));
  fs.mkdirSync(path.join(pluginDir, 'skills', 'nested', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'skills', 'nested', 'inner', 'SKILL.md'), '# nested\n');
  return loadEntry('portable-alpha');
}

function createOptionalSkillFrontmatterEntry(): CatalogEntry {
  const pluginDir = makePlugin('skill-optional-frontmatter');
  writePortableManifest(pluginDir);
  const invalidSkills = [
    ['bad-license', ['license:', '  - apache']],
    ['bad-compatibility', [`compatibility: ${'x'.repeat(501)}`]],
    ['bad-metadata', ['metadata:', '  author: ok', '  nested:', '    nope: bad']],
    ['bad-tools', ['allowed-tools:', '  - Bash']],
    ['unknown-field', ['category: helpers']],
  ] as const;
  for (const [name, extra] of invalidSkills) {
    makeSkill(pluginDir, name, skillText(name, { extra: [...extra] }));
  }
  makeSkill(pluginDir, 'good-optional', skillText('good-optional', {
    extra: [
      'license: Apache-2.0',
      'compatibility: Requires git and network access',
      'metadata:',
      '  author: example-org',
      '  version: "1.0"',
      'allowed-tools: Bash(git:*) Read',
    ],
  }));
  return loadEntry('skill-optional-frontmatter');
}

function assertPortableAlpha(entry: CatalogEntry) {
  expect(entry.kind).toBe('portable');
  expect(entry.valid).toBe(true);
  expect(entry.skills.map((skill) => skill.name)).toEqual(['summarize']);
  expect(entry.mcp.status).toBe('valid');
  expect(entry.mcp.servers.map((item) => item.name)).toEqual([
    'deployment-api',
    'local-validator',
  ]);
}

function assertPortableStdio(entry: CatalogEntry) {
  const stdio: any = pickServer(entry, 'local-validator');
  const runtime = runtimeFor(stdio);
  expect(stdio.summary.command).toBe('validator');
  expect(stdio.summary.argsCount).toBe(3);
  expect(stdio.summary.envKeys).toEqual(['CONFIG', 'PLUGIN_DATA', 'PLUGIN_ROOT']);
  expect(runtime.args).toEqual([
    '--data',
    path.join(pluginDataRoot, 'portable-alpha', 'validator'),
    '${UNKNOWN_TOKEN}',
  ]);
  expect(runtime.env.CONFIG).toBe(path.join(pluginsRoot, 'portable-alpha', 'config.json'));
  expect(runtime.cwd).toBe(path.join(pluginsRoot, 'portable-alpha'));
}

function assertPortableRemote(entry: CatalogEntry) {
  const remote: any = pickServer(entry, 'deployment-api');
  const runtime = runtimeFor(remote);
  expect(remote.url).toBeUndefined();
  expect(remote.summary.origin).toBe('http://[::1]:3000');
  expect(remote.summary.headerKeys).toEqual(['X-Tenant']);
  expect(runtime.url).toBe('http://[::1]:3000/mcp?token=secret');
  expect(runtime.headers).toEqual({ 'X-Tenant': 'public-tenant' });
  expect(JSON.stringify(remote)).toContain('http://[::1]:3000');
  expect(JSON.stringify(remote)).not.toContain('/mcp');
  expect(JSON.stringify(remote)).not.toContain('token=secret');
  expect(JSON.stringify(remote)).not.toContain('public-tenant');
}

describe('Agent Plugins v1 schema pins', () => {
  it('matches the vendored official plugin and MCP schema files', () => {
    expect(readVendored('plugin.schema.json')).toEqual(OFFICIAL_PLUGIN_SCHEMA);
    expect(readVendored('mcp.schema.json')).toEqual(OFFICIAL_MCP_SCHEMA);
  });

  it('accepts the official valid fixtures and rejects the official invalid fixture', () => {
    expect(portableManifestSchema.safeParse(OFFICIAL_VALID_MANIFEST).success).toBe(true);
    expect(portableManifestSchema.safeParse(OFFICIAL_INVALID_MANIFEST).success).toBe(false);
    expect(portableMcpSchema.safeParse(OFFICIAL_VALID_MCP).success).toBe(true);
    expect(portableMcpServerSchema.safeParse(OFFICIAL_INVALID_STDIO).success).toBe(false);
  });
});

it('loads a portable plugin with validated skills and sanitized MCP views', () => {
  const entry = createPortableAlpha();

  assertPortableAlpha(entry);
  assertPortableStdio(entry);
  assertPortableRemote(entry);
  expect(JSON.stringify(entry)).not.toContain(path.join(pluginsRoot, 'portable-alpha'));
});

it('does not fall back to a legacy manifest when root plugin.json is invalid', () => {
  const pluginDir = makePlugin('root-invalid');
  writePortableManifest(pluginDir, OFFICIAL_INVALID_MANIFEST);
  writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), { name: 'legacy-ok' });
  makeSkill(pluginDir, 'ignored');

  const entry = loadEntry('root-invalid');

  expect(entry.kind).toBe('portable');
  expect(entry.valid).toBe(false);
  expect(entry.manifest.source).toBe('root');
  expect(entry.skills).toEqual([]);
  expect(issueCodes(entry)).toContain('manifest_invalid');
});

it('does not fall back when plugin.json is a dangling symlink', () => {
  const pluginDir = makePlugin('root-dangling');
  fs.symlinkSync(path.join(pluginDir, 'missing-plugin.json'), path.join(pluginDir, 'plugin.json'));
  writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), { name: 'legacy-ok' });

  const entry = loadEntry('root-dangling');

  expect(entry.kind).toBe('portable');
  expect(entry.valid).toBe(false);
  expect(entry.manifest.source).toBe('root');
  expect(issueCodes(entry)).toContain('manifest_invalid');
});

it('falls back to .claude-plugin/plugin.json only when root plugin.json is absent', () => {
  const pluginDir = makePlugin('legacy-only');
  writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), {
    name: 'legacy-only',
    version: '0.1.0',
    description: 'legacy plugin',
  });
  makeSkill(pluginDir, 'commit');

  const entry = loadEntry('legacy-only');

  expect(entry.kind).toBe('legacy');
  expect(entry.valid).toBe(true);
  expect(entry.manifest.source).toBe('legacy');
  expect(entry.skills.map((skill) => skill.name)).toEqual(['commit']);
  expect(entry.mcp.status).toBe('missing');
});

it('keeps legacy .claude-plugin skills discoverable while portable plugins stay on strict Agent Skills validation', () => {
  const legacyDir = makePlugin('legacy-retains-skills');
  writeJson(path.join(legacyDir, '.claude-plugin', 'plugin.json'), {
    name: 'legacy-retains-skills',
    version: '0.1.0',
  });
  makeSkill(legacyDir, 'ship-legacy', legacySkillText('ship-legacy'));

  const portableDir = makePlugin('portable-strict-skills');
  writePortableManifest(portableDir, {
    ...OFFICIAL_VALID_MANIFEST,
    name: 'portable-strict-skills',
  });
  makeSkill(portableDir, 'ship-legacy', legacySkillText('ship-legacy'));

  const legacy = loadEntry('legacy-retains-skills');
  const portable = loadEntry('portable-strict-skills');

  expect(legacy.kind).toBe('legacy');
  expect(legacy.skills.map((skill) => skill.name)).toEqual(['ship-legacy']);
  expect(issueCodes(legacy)).toEqual([]);

  expect(portable.kind).toBe('portable');
  expect(portable.skills).toEqual([]);
  expect(issueMessages(portable, 'skill_invalid')).toEqual(expect.arrayContaining([
    'SKILL.md frontmatter allowed-tools must be a string when present',
    'SKILL.md frontmatter contains unknown fields: argument-hint, author, date, version',
  ]));
});

it('marks dangling or empty mcp.json files invalid without hiding skills', () => {
  const danglingDir = makePlugin('mcp-dangling');
  writePortableManifest(danglingDir);
  fs.symlinkSync(path.join(danglingDir, 'missing-mcp.json'), path.join(danglingDir, 'mcp.json'));
  makeSkill(danglingDir, 'analyze');

  const dangling = loadEntry('mcp-dangling');
  expect(dangling.skills.map((skill) => skill.name)).toEqual(['analyze']);
  expect(dangling.mcp.status).toBe('invalid');

  const emptyDir = makePlugin('mcp-empty');
  writePortableManifest(emptyDir);
  fs.writeFileSync(path.join(emptyDir, 'mcp.json'), '');
  makeSkill(emptyDir, 'inspect');

  const empty = loadEntry('mcp-empty');
  expect(empty.skills.map((skill) => skill.name)).toEqual(['inspect']);
  expect(empty.mcp.status).toBe('invalid');
  expect(issueCodes(dangling)).toContain('mcp_invalid');
  expect(issueCodes(empty)).toContain('mcp_invalid');
});

it('disables only malformed top-level mcp.json while keeping valid skills', () => {
  const pluginDir = makePlugin('mcp-top-level-invalid');
  writePortableManifest(pluginDir);
  writeJson(path.join(pluginDir, 'mcp.json'), { $schema: AGENT_PLUGIN_V1_MCP_SCHEMA_URL });
  makeSkill(pluginDir, 'analyze');

  const entry = loadEntry('mcp-top-level-invalid');

  expect(entry.valid).toBe(true);
  expect(entry.skills.map((skill) => skill.name)).toEqual(['analyze']);
  expect(entry.mcp.status).toBe('invalid');
  expect(entry.mcp.servers).toEqual([]);
  expect(issueCodes(entry)).toContain('mcp_invalid');
});

it('rejects reserved stdio env keys with platform-insensitive comparison', () => {
  const pluginDir = makePlugin('mcp-env-reserved');
  writePortableManifest(pluginDir);
  writeMcp(pluginDir, { bad: { type: 'stdio', command: 'node', env: { plugin_root: 'x', Plugin_Data: 'y' } } });
  const entry = loadEntry('mcp-env-reserved');
  expect(entry.valid).toBe(true);
  expect(entry.mcp.servers).toEqual([]);
  expect(issueCodes(entry)).toContain('mcp_server_invalid');
});

it('skips only invalid individual MCP entries', () => {
  const pluginDir = makePlugin('mcp-entry-invalid');
  writePortableManifest(pluginDir);
  writeMcp(pluginDir, {
    ok: { type: 'stdio', command: 'node', args: ['server.mjs'] },
    insecure: { type: 'streamable-http', url: 'http://example.com/mcp' },
    'bad-cwd': OFFICIAL_INVALID_STDIO,
  });

  const entry = loadEntry('mcp-entry-invalid');

  expect(entry.valid).toBe(true);
  expect(entry.mcp.status).toBe('valid');
  expect(entry.mcp.servers.map((item) => item.name)).toEqual(['ok']);
  expect(issueCodes(entry)).toContain('mcp_server_invalid');
});

it('rejects plugin roots that escape PLUGINS_DIR through symlinks', () => {
  fs.mkdirSync(pluginsRoot, { recursive: true });
  const external = outsideDir('plugin-outside-');
  writePortableManifest(external);
  const linkPath = path.join(pluginsRoot, 'escaped-root');
  fs.symlinkSync(external, linkPath, 'dir');
  cleanup.push(linkPath);

  const entry = loadEntry('escaped-root');

  expect(entry.valid).toBe(false);
  expect(issueCodes(entry)).toContain('plugin_root_outside_plugins_dir');
});

it('skips malformed skills per Agent Skills frontmatter rules', () => {
  const pluginDir = makePlugin('skill-frontmatter');
  writePortableManifest(pluginDir);
  makeSkill(pluginDir, 'missing-frontmatter', '# missing\n');
  makeSkill(pluginDir, 'wrong-name', [
    '---',
    'name: other-name',
    'description: Should be rejected because the name mismatches.',
    '---',
    '# wrong-name',
    '',
  ].join('\n'));
  makeSkill(pluginDir, 'empty-description', skillText('empty-description', {
    description: '   ',
  }));
  makeSkill(pluginDir, 'good-skill', skillText('good-skill', {
    description: 'A valid skill with proper frontmatter.',
  }));

  const entry = loadEntry('skill-frontmatter');

  expect(entry.skills.map((skill) => skill.name)).toEqual(['good-skill']);
  expect(issueCodes(entry)).toContain('skill_invalid');
});

it('rejects malformed optional skill frontmatter fields and unknown keys', () => {
  const entry = createOptionalSkillFrontmatterEntry();

  expect(entry.skills.map((skill) => skill.name)).toEqual(['good-optional']);
  expect(issueMessages(entry, 'skill_invalid')).toEqual(
    expect.arrayContaining([...OPTIONAL_SKILL_MESSAGES]),
  );
});

it('inventories every shipped legacy defaults skill directory with a non-zero count', () => {
  const catalog = loadPluginCatalog({
    pluginsDir: defaultsPluginsRoot,
    dataDir: path.join(homeRoot, 'data', 'defaults-plugin-catalog'),
  });
  const expectedLegacy = fs.readdirSync(defaultsPluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const id = entry.name;
      const skillsDir = path.join(defaultsPluginsRoot, id, 'skills');
      const skillNames = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .map((child) => child.name)
        .sort();
      return { id, skillNames };
    });

  expect(expectedLegacy.length).toBeGreaterThan(0);
  expect(expectedLegacy.flatMap((entry) => entry.skillNames).length).toBeGreaterThan(0);
  for (const expected of expectedLegacy) {
    const entry = pickPlugin(catalog, expected.id);
    expect(entry.kind).toBe('legacy');
    expect(entry.skills.map((skill) => skill.name)).toEqual(expected.skillNames);
    expect(entry.skills.length).toBeGreaterThan(0);
  }
});

it('rejects PLUGIN_DATA symlink escapes after physical containment checks', () => {
  const fixture = makeRootFixture('plugin-data-root-');
  const pluginDir = path.join(fixture.pluginsDir, 'data-escape');
  const outside = outsideDir('plugin-data-outside-');
  fs.mkdirSync(pluginDir, { recursive: true });
  writePortableManifest(pluginDir);
  const dataPluginDir = path.join(fixture.dataDir, 'data', 'plugin-data', 'data-escape');
  fs.mkdirSync(dataPluginDir, { recursive: true });
  fs.symlinkSync(outside, path.join(dataPluginDir, 'link'), 'dir');
  writeMcp(pluginDir, { bad: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/link' } });

  const entry = loadEntry('data-escape', fixture);

  expect(entry.valid).toBe(true);
  expect(entry.mcp.servers).toEqual([]);
  expect(issueCodes(entry)).toContain('mcp_server_invalid');
});

it('catalog parsing computes but does not create PLUGIN_DATA for stdio servers', () => {
  const fixture = makeRootFixture('plugin-data-purity-');
  const pluginDir = path.join(fixture.pluginsDir, 'stdio-pure');
  const dataPluginDir = path.join(fixture.dataDir, 'data', 'plugin-data', 'stdio-pure');
  fs.mkdirSync(pluginDir, { recursive: true });
  writePortableManifest(pluginDir);
  writeMcp(pluginDir, { pure: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}' } });
  const entry = loadEntry('stdio-pure', fixture);
  expect(entry.valid).toBe(true);
  expect(entry.mcp.servers.map((item) => item.name)).toEqual(['pure']);
  expect(fs.existsSync(dataPluginDir)).toBe(false);
});

it('expands PLUGIN_ROOT and PLUGIN_DATA in args and env as opaque one-pass strings', () => {
  const fixture = makeRootFixture('plugins-${PLUGIN_DATA}-');
  const pluginDir = path.join(fixture.pluginsDir, 'one-pass');
  fs.mkdirSync(pluginDir, { recursive: true });
  writePortableManifest(pluginDir);
  writeMcp(pluginDir, { one: {
    type: 'stdio',
    command: 'node',
    args: ['${PLUGIN_ROOT}/../outside', '${PLUGIN_DATA}/../cache'],
    env: { CONFIG: '${PLUGIN_ROOT}/../secret', CACHE: '${PLUGIN_DATA}/../vault' },
  } });
  const runtime = runtimeFor(loadEntry('one-pass', fixture).mcp.servers[0]);
  expect(runtime.args).toEqual([`${pluginDir}/../outside`,
    `${path.join(fixture.dataDir, 'data', 'plugin-data', 'one-pass')}/../cache`,
  ]);
  expect(runtime.env).toEqual({
    CONFIG: `${pluginDir}/../secret`,
    CACHE: `${path.join(fixture.dataDir, 'data', 'plugin-data', 'one-pass')}/../vault`,
    PLUGIN_ROOT: pluginDir,
    PLUGIN_DATA: path.join(fixture.dataDir, 'data', 'plugin-data', 'one-pass'),
  });
});

it('keeps valid MCP when a present skills directory escapes the plugin root', () => {
  const pluginDir = makePlugin('skills-escape');
  const outside = outsideDir('skills-outside-');
  writePortableManifest(pluginDir);
  writeMcp(pluginDir, { api: { type: 'streamable-http', url: 'https://example.com/mcp' } });
  fs.symlinkSync(outside, path.join(pluginDir, 'skills'), 'dir');

  const entry = loadEntry('skills-escape');

  expect(entry.valid).toBe(true);
  expect(entry.skills).toEqual([]);
  expect(entry.mcp.status).toBe('valid');
  expect(entry.mcp.servers.map((item) => item.name)).toEqual(['api']);
  expect(issueMessages(entry, 'skill_invalid')).toContain('skills must resolve to a directory inside the plugin root');
});

it('survives a skills directory read failure without losing MCP or sibling plugins', () => {
  const brokenDir = makePlugin('skills-read-failed');
  const goodDir = makePlugin('skills-sibling');
  writePortableManifest(brokenDir);
  writePortableManifest(goodDir);
  writeMcp(brokenDir, { ok: { type: 'stdio', command: 'node' } });
  fs.mkdirSync(path.join(brokenDir, 'skills'), { recursive: true });
  makeSkill(goodDir, 'good-skill');

  const readdirSync = fs.readdirSync.bind(fs);
  vi.spyOn(fs, 'readdirSync').mockImplementation(((filePath: any, ...args: any[]) => {
    if (String(filePath) === path.join(brokenDir, 'skills')) throw new Error('simulated readdir failure');
    return readdirSync(filePath, ...(args as [any]));
  }) as typeof fs.readdirSync);

  const catalog = loadPluginCatalog();
  const broken = pickPlugin(catalog, 'skills-read-failed');
  const good = pickPlugin(catalog, 'skills-sibling');

  expect(broken.valid).toBe(true);
  expect(broken.mcp.servers.map((item) => item.name)).toEqual(['ok']);
  expect(issueMessages(broken, 'skill_invalid')).toContain('skills could not be read');
  expect(good.valid).toBe(true);
  expect(good.skills.map((skill) => skill.name)).toEqual(['good-skill']);
});

it('survives a per-plugin manifest read failure and still loads siblings', () => {
  const brokenDir = makePlugin('broken-read');
  const goodDir = makePlugin('good-read');
  writePortableManifest(brokenDir);
  writePortableManifest(goodDir);
  makeSkill(goodDir, 'good-read');

  const brokenFile = path.join(brokenDir, 'plugin.json');
  const readFileSync = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath: any, ...args: any[]) => {
    if (String(filePath) === brokenFile) throw new Error('simulated read race');
    return readFileSync(filePath, ...(args as [any]));
  }) as typeof fs.readFileSync);

  const catalog = loadPluginCatalog();
  const broken = pickPlugin(catalog, 'broken-read');
  const good = pickPlugin(catalog, 'good-read');

  expect(good.valid).toBe(true);
  expect(good.skills.map((skill) => skill.name)).toEqual(['good-read']);
  expect(broken.valid).toBe(false);
  expect(issueCodes(broken)).toContain('manifest_invalid');
});

it('skips immediate skills and MCP commands that resolve outside the plugin root', () => {
  const pluginDir = makePlugin('symlink-escape');
  const outside = outsideDir('plugin-skill-outside-');
  writePortableManifest(pluginDir);
  fs.mkdirSync(path.join(pluginDir, 'skills', 'escape'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '# outside\n');
  fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(pluginDir, 'skills', 'escape', 'SKILL.md'));
  fs.symlinkSync(outside, path.join(pluginDir, 'bin'), 'dir');
  writeMcp(pluginDir, { bad: { type: 'stdio', command: './bin/server' } });

  const entry = loadEntry('symlink-escape');

  expect(entry.valid).toBe(true);
  expect(entry.skills).toEqual([]);
  expect(entry.mcp.servers).toEqual([]);
  expect(issueCodes(entry)).toEqual(['mcp_server_invalid', 'skill_outside_plugin_root']);
});
