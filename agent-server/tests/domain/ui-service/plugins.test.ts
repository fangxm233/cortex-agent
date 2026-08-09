// input:  plugin fixtures and UI handlers
// output: plugin list/assign and router coverage
// pos:    ui-service plugin API regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import '../../_test-home.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { TRPCError } from '@trpc/server';
import { beforeEach, test } from 'vitest';
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
  PluginTemplateShellBindingTarget,
  PluginTemplateSlotTarget,
  PluginsAssignArgs,
  UiServiceDeps,
} from '../../../src/domain/ui-service/types.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import {
  getAgent,
  getTemplate,
  loadConfig,
} from '../../../src/domain/threads/template-loader.js';

const TT_DIR = path.join(CONFIG_DIR, 'thread-templates');
const AGENTS_DIR = path.join(TT_DIR, 'agents');
const TEMPLATES_DIR = path.join(TT_DIR, 'templates');
const WRITER_FILE = path.join(AGENTS_DIR, 'writer.json');
const WORKFLOW_FILE = path.join(TEMPLATES_DIR, 'workflow.json');
const MALFORMED_AGENT_FILE = path.join(AGENTS_DIR, 'badreader.json');

type ListResult = Awaited<ReturnType<typeof handlePluginsList>>;
type AssignResult = Awaited<ReturnType<typeof handlePluginsAssign>>;

function deps(): UiServiceDeps {
  return {
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    bus: { publish: () => {}, subscribe: () => ({ unsubscribe: () => {} }) },
  } as unknown as UiServiceDeps;
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

function templateBody() {
  return {
    name: 'workflow',
    description: 'workflow template',
    agents: [
      'writer',
      {
        ref: 'writer',
        tools: 'Read',
        pluginDirs: [path.join(PLUGINS_DIR, 'beta'), 'plugins/alpha', '/opt/slot-extra'],
      },
      '__active__',
    ],
    transitions: [],
    entryAgent: 'writer',
    maxTotalSteps: 1,
  };
}

function shellDefinition() {
  return {
    params: ['worker', 'reviewer'],
    agents: ['{worker}', '{reviewer}'],
    transitions: [{ from: '{worker}:{worker.entryStage}', to: '{reviewer}', condition: { type: 'always' } }],
    entryAgent: '{worker}',
    entryStage: '{worker.entryStage}',
    maxTotalSteps: 2,
  };
}

function shellBindingTemplate() {
  return {
    shell: 'review',
    worker: 'writer',
    reviewer: 'writer',
    description: 'shell binding',
  };
}

function seedEntity(
  subdir: 'agents' | 'templates' | 'shells',
  name: string,
  body: unknown,
): void {
  const dir = path.join(TT_DIR, subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
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

function seedFixture(): void {
  rmSync(TT_DIR, { recursive: true, force: true });
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  mkdirSync(TT_DIR, { recursive: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
  seedPortablePlugin('alpha');
  seedPortablePlugin('beta');
  seedPortablePlugin('mcp-plugin', { mcp: true });
  seedPortablePlugin('broken', { invalid: true });
  seedEntity('agents', 'writer', agentBody('writer', writerPluginDirs()));
  seedEntity('agents', 'reviewer', agentBody('reviewer'));
  seedEntity('templates', 'workflow', templateBody());
  seedEntity('shells', 'review', shellDefinition());
  seedEntity('templates', 'bound', shellBindingTemplate());
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

function slotTarget(
  result: ListResult,
  templateName: string,
  index: number,
): PluginTemplateSlotTarget {
  const target = result.targets.find(
    (value): value is PluginTemplateSlotTarget => value.kind === 'template-slot'
      && value.templateName === templateName
      && value.index === index,
  );
  assert.ok(target, `missing slot target ${templateName}[${index}]`);
  return target;
}

function shellTarget(
  result: ListResult,
  templateName: string,
): PluginTemplateShellBindingTarget {
  const target = result.targets.find(
    (value): value is PluginTemplateShellBindingTarget => value.kind === 'template-shell'
      && value.templateName === templateName,
  );
  assert.ok(target, `missing shell target ${templateName}`);
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

function assign(args: PluginsAssignArgs): Promise<AssignResult> {
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

function assignSlot(
  target: PluginTemplateSlotTarget,
  pluginIds: string[],
  mode = target.mode,
  acknowledgeMcp?: boolean,
): Promise<AssignResult> {
  return assign({
    target: {
      kind: 'template-slot',
      templateName: target.templateName,
      index: target.index,
      ref: target.ref,
      baseHash: target.baseHash,
      mode,
    },
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
  const inherit = slotTarget(result, 'workflow', 0);
  const custom = slotTarget(result, 'workflow', 1);
  const active = slotTarget(result, 'workflow', 2);
  const binding = shellTarget(result, 'bound');
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
  assert.equal(inherit.mode, 'inherit');
  assert.deepEqual(inherit.managedPluginIds, ['alpha', 'broken']);
  assert.equal(inherit.unmanagedPluginCount, 1);
  assert.equal(custom.mode, 'custom');
  assert.deepEqual(custom.managedPluginIds, ['beta', 'alpha']);
  assert.equal(custom.unmanagedPluginCount, 1);
  assert.equal(active.readOnlyReason, 'active-agent');
  assert.equal(binding.readOnlyReason, 'shell-binding');
});

test('plugins.list is reachable through the facade and router', async () => {
  const service = createUiService(deps());
  const query = await service.query('plugins.list', {});
  const listedViaRouter = await routerCaller().plugins.list({});

  assert.ok(query.ok, JSON.stringify(query));
  assert.ok(listedViaRouter.targets.length >= 5);
});

test('plugins.assign keeps only out-of-catalog agent paths', async () => {
  loadConfig();
  const writer = agentTarget(await listed(), 'writer');
  const result = await assignAgent(writer, ['beta']);

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(readJson(WRITER_FILE).pluginDirs, ['plugins/beta', '/opt/agent-extra']);
  assert.deepEqual(getAgent('writer')?.pluginDirs, [
    path.join(PLUGINS_DIR, 'beta'),
    '/opt/agent-extra',
  ]);
});

test('switching inherit to custom copies inherited snapshot', async () => {
  loadConfig();
  const target = slotTarget(await listed(), 'workflow', 0);
  const result = await assignSlot(target, ['alpha', 'broken'], 'custom');

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(readJson(WORKFLOW_FILE).agents[0], {
    ref: 'writer',
    pluginDirs: ['plugins/alpha', 'plugins/broken', '/opt/agent-extra'],
  });
  assert.deepEqual((getTemplate('workflow')?.agents[0] as { pluginDirs?: string[] }).pluginDirs, [
    'plugins/alpha',
    'plugins/broken',
    '/opt/agent-extra',
  ]);
});

test('custom slot writes preserve unmanaged entries', async () => {
  const target = slotTarget(await listed(), 'workflow', 1);
  const result = await assignSlot(target, ['mcp-plugin', 'alpha'], 'custom', true);

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(readJson(WORKFLOW_FILE).agents[1], {
    ref: 'writer',
    tools: 'Read',
    pluginDirs: ['plugins/mcp-plugin', 'plugins/alpha', '/opt/slot-extra'],
  });
});

test('inherit mode drops slot pluginDirs and keeps overrides', async () => {
  const target = slotTarget(await listed(), 'workflow', 1);
  const result = await assignSlot(target, ['alpha', 'broken'], 'inherit');

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(readJson(WORKFLOW_FILE).agents[1], {
    ref: 'writer',
    tools: 'Read',
  });
});

test('agent MCP additions require acknowledgeMcp', async () => {
  const writer = agentTarget(await listed(), 'writer');
  const rejected = await assignAgent(writer, ['alpha', 'broken', 'mcp-plugin']);
  const accepted = await assignAgent(writer, ['alpha', 'broken', 'mcp-plugin'], true);

  expectCode(rejected, 'invalid-args');
  assert.ok(accepted.ok, JSON.stringify(accepted));
});

test('template MCP additions require acknowledgeMcp', async () => {
  const target = slotTarget(await listed(), 'workflow', 1);
  const rejected = await assignSlot(target, ['alpha', 'mcp-plugin']);
  const accepted = await assignSlot(target, ['alpha', 'mcp-plugin'], 'custom', true);

  expectCode(rejected, 'invalid-args');
  assert.ok(accepted.ok, JSON.stringify(accepted));
});

test('plugins.assign rejects stale agent and template hashes', async () => {
  const writer = agentTarget(await listed(), 'writer');
  const target = slotTarget(await listed(), 'workflow', 1);
  const changedWriter = await assignAgent(writer, ['beta']);
  const changedSlot = await assignSlot(target, ['alpha'], 'custom');

  assert.ok(changedWriter.ok, JSON.stringify(changedWriter));
  assert.ok(changedSlot.ok, JSON.stringify(changedSlot));
  expectCode(await assignAgent(writer, ['alpha']), 'conflict');
  expectCode(await assignSlot(target, ['alpha'], 'inherit'), 'conflict');
});

test('plugins.assign stale hashes map to router CONFLICT', async () => {
  const caller = routerCaller();
  const writer = agentTarget(await caller.plugins.list({}), 'writer');
  const changed = await caller.plugins.assign({
    target: { kind: 'agent', name: writer.name, baseHash: writer.baseHash },
    pluginIds: ['beta'],
  });

  assert.equal(changed.changed, true);
  await assert.rejects(
    () => caller.plugins.assign({
      target: { kind: 'agent', name: writer.name, baseHash: writer.baseHash },
      pluginIds: ['alpha'],
    }),
    (error: unknown) => error instanceof TRPCError
      && error.code === 'CONFLICT'
      && (error.cause as { code?: string } | undefined)?.code === 'conflict',
  );
});

test('plugins.assign rejects reordered template slots after refresh', async () => {
  const target = slotTarget(await listed(), 'workflow', 1);
  const body = readJson(WORKFLOW_FILE);

  body.agents = ['writer', 'reviewer', body.agents[1], '__active__'];
  writeFileSync(WORKFLOW_FILE, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  const baseHash = slotTarget(await listed(), 'workflow', 1).baseHash;
  const result = await assign({
    target: { ...target, baseHash, mode: 'custom' },
    pluginIds: ['alpha'],
  });

  expectCode(result, 'invalid-args');
});

test('plugins.assign rejects shell bindings and __active__ slots', async () => {
  const result = await listed();
  const shell = await assign({
    target: {
      kind: 'template-slot',
      templateName: 'bound',
      index: 0,
      ref: 'writer',
      baseHash: shellTarget(result, 'bound').baseHash,
      mode: 'custom',
    },
    pluginIds: ['alpha'],
  });
  const active = await assign({
    target: {
      kind: 'template-slot',
      templateName: 'workflow',
      index: 2,
      ref: '__active__',
      baseHash: slotTarget(result, 'workflow', 2).baseHash,
      mode: 'inherit',
    },
    pluginIds: [],
  });

  expectCode(shell, 'invalid-args');
  expectCode(active, 'invalid-args');
});

test('plugins.assign rejects adding invalid ids to new targets', async () => {
  const reviewer = agentTarget(await listed(), 'reviewer');
  const target = slotTarget(await listed(), 'workflow', 1);

  expectCode(await assignAgent(reviewer, ['broken']), 'invalid-args');
  expectCode(await assignSlot(target, ['alpha', 'broken']), 'invalid-args');
});

test('plugins.list skips malformed agent JSON without editing it', async () => {
  writeFileSync(MALFORMED_AGENT_FILE, '{\n  "name": "badreader",\n', 'utf8');
  const original = readFileSync(MALFORMED_AGENT_FILE, 'utf8');

  const result = await listed();
  const listedViaRouter = await routerCaller().plugins.list({});

  assert.ok(!result.targets.some((target) => target.kind === 'agent' && target.name === 'badreader'));
  assert.ok(!listedViaRouter.targets.some((target) => target.kind === 'agent' && target.name === 'badreader'));
  assert.equal(slotTarget(result, 'workflow', 0).ref, 'writer');
  assert.equal(slotTarget(result, 'workflow', 1).ref, 'writer');
  assert.equal(slotTarget(result, 'workflow', 2).ref, '__active__');
  assert.equal(readFileSync(MALFORMED_AGENT_FILE, 'utf8'), original);
});

test('plugins.assign is reachable through the router', async () => {
  const caller = routerCaller();
  const writer = agentTarget(await caller.plugins.list({}), 'writer');
  const result = await caller.plugins.assign({
    target: { kind: 'agent', name: 'writer', baseHash: writer.baseHash },
    pluginIds: ['beta'],
  });

  assert.equal(result.changed, true);
  assert.equal(typeof result.baseHash, 'string');
});
