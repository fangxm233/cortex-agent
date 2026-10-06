import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, test } from 'vitest';
import { EventBus } from '../../../src/events/event-bus.js';
import { CONFIG_DIR, PLUGINS_DIR } from '../../../src/core/paths.js';
import {
  AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
  AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
} from '../../../src/domain/plugins/agent-plugins-v1.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import { handlePluginsAssign } from '../../../src/domain/ui-service/mutate/plugins.js';
import { handlePluginsList } from '../../../src/domain/ui-service/query/plugins.js';
import type {
  PluginAgentTarget,
  UiServiceDeps,
  MutateArgs,
} from '../../../src/domain/ui-service/types.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import { getEnvironment } from '../../../src/domain/agents/environments/index.js';

const ENV_DIR = path.join(CONFIG_DIR, 'environments');
const WRITER_FILE = path.join(ENV_DIR, 'writer.json');
const MALFORMED_AGENT_FILE = path.join(ENV_DIR, 'badreader.json');

type ListResult = Awaited<ReturnType<typeof handlePluginsList>>;
type AssignResult = Awaited<ReturnType<typeof handlePluginsAssign>>;

function deps(): UiServiceDeps {
  return {
    bus: new EventBus(),
  } as unknown as UiServiceDeps;
}

function environmentBody(name: string, pluginDirs?: string[]) {
  return {
    name,
    description: `${name} environment`,
    profile: 'plan',
    persistSession: true,
    tools: 'Read',
    ...(pluginDirs ? { pluginDirs } : {}),
  };
}

function seedPortablePlugin(
  id: string,
  options: { mcp?: boolean; invalid?: boolean } = {},
): void {
  const dir = path.join(PLUGINS_DIR, id);
  mkdirSync(path.join(dir, 'skills', 'helper'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'helper', 'SKILL.md'), skillMarkdown(), 'utf8');
  writeFileSync(path.join(dir, 'plugin.json'), portableManifest(id, options.invalid), 'utf8');
  if (options.mcp) seedPortableMcp(dir);
}

function skillMarkdown(): string {
  return '---\nname: helper\ndescription: helper skill\n---\n# helper\n';
}

function portableManifest(id: string, invalid = false): string {
  return JSON.stringify({
    $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
    name: invalid ? 'Bad Plugin' : id,
    version: '1.0.0',
    description: `${id} description`,
  }, null, 2);
}

function seedPortableMcp(dir: string): void {
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'bin', 'private-server'), '#!/bin/sh\n', 'utf8');
  writeFileSync(path.join(dir, 'mcp.json'), portableMcp(), 'utf8');
}

function portableMcp(): string {
  return JSON.stringify({
    $schema: AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
    mcpServers: {
      local: {
        type: 'stdio',
        command: './bin/private-server',
        args: ['--token', 'super-secret-arg'],
        env: { SECRET_TOKEN: 'super-secret-env' },
        cwd: '${PLUGIN_ROOT}',
      },
      remote: {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp?token=super-secret-query',
        headers: { Authorization: 'Bearer super-secret-header', 'X-Team': 'ops' },
      },
    },
  }, null, 2);
}

function seedEnvironment(name: string, body: unknown): void {
  mkdirSync(ENV_DIR, { recursive: true });
  writeFileSync(path.join(ENV_DIR, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function seedFixture(): void {
  rmSync(ENV_DIR, { recursive: true, force: true });
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
  seedPortablePlugin('alpha');
  seedPortablePlugin('beta');
  seedPortablePlugin('mcp-plugin', { mcp: true });
  seedPortablePlugin('broken', { invalid: true });
  seedEnvironment('writer', environmentBody('writer', writerPluginDirs()));
  seedEnvironment('reviewer', environmentBody('reviewer'));
}

function writerPluginDirs(): string[] {
  return [
    'plugins/alpha',
    './plugins/alpha',
    path.join(PLUGINS_DIR, 'alpha'),
    'plugins/broken',
    '/opt/agent-extra',
  ];
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function agentTarget(result: ListResult, name: string): PluginAgentTarget {
  const target = result.targets.find(
    (value): value is PluginAgentTarget => value.kind === 'agent' && value.name === name,
  );
  assert.ok(target, `missing agent target ${name}`);
  return target;
}

function expectCode(result: AssignResult, code: string): void {
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, code);
}

function listed(): Promise<ListResult> {
  return handlePluginsList(deps(), {});
}

function routerCaller() {
  return createAppRouter(createUiService(deps())).createCaller({});
}

function assign(args: MutateArgs<'plugins.assign'>): Promise<AssignResult> {
  return handlePluginsAssign(deps(), args);
}

function assignAgent(
  target: PluginAgentTarget,
  pluginIds: string[],
  acknowledgeMcp?: boolean,
): Promise<AssignResult> {
  return assign({
    target: { kind: 'agent', name: target.name, baseHash: target.baseHash },
    pluginIds,
    acknowledgeMcp,
  });
}

beforeEach(() => {
  seedFixture();
});

test('plugins.list sanitizes DTOs and maps invalid installs', async () => {
  const result = await listed();
  const serialized = JSON.stringify(result);
  const writer = agentTarget(result, 'writer');
  const alpha = result.plugins.find((plugin) => plugin.id === 'alpha');

  assert.equal(result.plugins.length, 4);
  assert.equal(alpha?.manifest.schema, AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL);
  assert.ok(result.plugins.some((plugin) => plugin.id === 'broken' && plugin.assignable === false));
  assert.ok(result.plugins.some((plugin) => plugin.id === 'mcp-plugin' && plugin.mcp.servers.length === 2));
  assert.ok(!serialized.includes(path.join(PLUGINS_DIR, 'mcp-plugin')));
  assert.ok(!serialized.includes('super-secret-env'));
  assert.ok(!serialized.includes('super-secret-header'));
  assert.ok(!serialized.includes('super-secret-query'));
  assert.ok(!serialized.includes('/opt/agent-extra'));
  assert.deepEqual(writer.managedPluginIds, ['alpha', 'broken']);
  assert.equal(writer.unmanagedPluginCount, 1);
  assert.deepEqual(result.targets.map((target) => target.name).sort(), ['reviewer', 'writer']);
});

test('plugins.assign keeps only out-of-catalog agent paths', async () => {
  const writer = agentTarget(await listed(), 'writer');
  const result = await assignAgent(writer, ['beta']);

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(readJson(WRITER_FILE).pluginDirs, ['plugins/beta', '/opt/agent-extra']);
  assert.deepEqual(getEnvironment('writer')?.pluginDirs, [
    path.join(PLUGINS_DIR, 'beta'),
    '/opt/agent-extra',
  ]);
});

test('agent MCP additions require acknowledgeMcp', async () => {
  const writer = agentTarget(await listed(), 'writer');
  const rejected = await assignAgent(writer, ['alpha', 'broken', 'mcp-plugin']);
  const accepted = await assignAgent(writer, ['alpha', 'broken', 'mcp-plugin'], true);

  expectCode(rejected, 'invalid-args');
  assert.ok(accepted.ok, JSON.stringify(accepted));
});

test('plugins.assign rejects a stale agent hash', async () => {
  const writer = agentTarget(await listed(), 'writer');
  const changedWriter = await assignAgent(writer, ['beta']);

  assert.ok(changedWriter.ok, JSON.stringify(changedWriter));
  expectCode(await assignAgent(writer, ['alpha']), 'conflict');
});

test('plugins.assign rejects adding invalid ids to new targets', async () => {
  const reviewer = agentTarget(await listed(), 'reviewer');

  expectCode(await assignAgent(reviewer, ['broken']), 'invalid-args');
});

test('plugins.list skips malformed agent JSON without editing it', async () => {
  writeFileSync(MALFORMED_AGENT_FILE, '{\n  "name": "badreader",\n', 'utf8');
  const original = readFileSync(MALFORMED_AGENT_FILE, 'utf8');

  const result = await listed();
  const listedViaRouter = await routerCaller().plugins.list({});

  assert.ok(!result.targets.some((target) => target.kind === 'agent' && target.name === 'badreader'));
  assert.ok(!listedViaRouter.targets.some((target) => target.kind === 'agent' && target.name === 'badreader'));
  assert.equal(readFileSync(MALFORMED_AGENT_FILE, 'utf8'), original);
});
