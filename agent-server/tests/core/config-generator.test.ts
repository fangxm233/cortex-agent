// input:  scoped MCP config builders
// output: direct and layered config structure verification
// pos:    Config-generator pure-logic tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildCoreConfig,
  buildFeishuConfig,
  buildFullConfig,
  buildManagerQaConfig,
  buildTasksConfig,
  buildThreadConfig,
  buildTuiConfig,
  buildWebConfig,
} from '../../src/core/config-generator.js';

// ─── buildFullConfig ────────────────────────────────────────────

test('buildFullConfig returns always-on direct servers without thread control', () => {
  const config = buildFullConfig('/test/server') as any;
  assert.ok(config.mcpServers);
  const keys = Object.keys(config.mcpServers);
  assert.deepEqual(keys.sort(), ['cortex-core', 'cortex-ext', 'cortex-manager-qa', 'cortex-tasks']);
  assert.ok(!keys.includes('cortex-thread'));
});

test('buildFullConfig uses provided serverRoot as cwd', () => {
  const config = buildFullConfig('/my/server/root') as any;
  assert.equal(config.mcpServers['cortex-core'].cwd, '/my/server/root');
  assert.equal(config.mcpServers['cortex-tasks'].cwd, '/my/server/root');
  assert.equal(config.mcpServers['cortex-manager-qa'].cwd, '/my/server/root');
  assert.equal(config.mcpServers['cortex-ext'].cwd, '/my/server/root');
});

test('buildFullConfig cortex-core points to core-server.js (absolute path)', () => {
  const config = buildFullConfig('/test') as any;
  assert.equal(config.mcpServers['cortex-core'].command, 'node');
  assert.deepEqual(config.mcpServers['cortex-core'].args, ['/test/dist/domain/mcp/core-server.js']);
});

test('buildFullConfig cortex-tasks points to tasks-server.js (absolute path)', () => {
  const config = buildFullConfig('/test') as any;
  assert.equal(config.mcpServers['cortex-tasks'].command, 'node');
  assert.deepEqual(config.mcpServers['cortex-tasks'].args, ['/test/dist/domain/mcp/tasks-server.js']);
});

test('buildFullConfig cortex-manager-qa points to its server entry', () => {
  const config = buildFullConfig('/test') as any;
  assert.equal(config.mcpServers['cortex-manager-qa'].command, 'node');
  assert.deepEqual(
    config.mcpServers['cortex-manager-qa'].args,
    ['/test/dist/domain/mcp/manager-qa-server.js'],
  );
});

test('buildFullConfig cortex-ext points to server.js (absolute path)', () => {
  const config = buildFullConfig('/test') as any;
  assert.equal(config.mcpServers['cortex-ext'].command, 'node');
  assert.deepEqual(config.mcpServers['cortex-ext'].args, ['/test/dist/domain/mcp/server.js']);
});

// ─── buildCoreConfig ────────────────────────────────────────────

test('buildCoreConfig returns only cortex-core server', () => {
  const config = buildCoreConfig('/test/server') as any;
  assert.ok(config.mcpServers);
  const keys = Object.keys(config.mcpServers);
  assert.equal(keys.length, 1);
  assert.ok(keys.includes('cortex-core'));
});

test('buildCoreConfig uses provided serverRoot as cwd', () => {
  const config = buildCoreConfig('/my/server/root') as any;
  assert.equal(config.mcpServers['cortex-core'].cwd, '/my/server/root');
});

// ─── Privilege-layer configs ────────────────────────────────────

test('buildTasksConfig returns only cortex-tasks', () => {
  const config = buildTasksConfig('/test/server') as any;
  assert.deepEqual(Object.keys(config.mcpServers), ['cortex-tasks']);
  assert.deepEqual(
    config.mcpServers['cortex-tasks'].args,
    ['/test/server/dist/domain/mcp/tasks-server.js'],
  );
  assert.equal(config.mcpServers['cortex-tasks'].cwd, '/test/server');
});

test('buildManagerQaConfig returns only cortex-manager-qa', () => {
  const config = buildManagerQaConfig('/test/server') as any;
  assert.deepEqual(Object.keys(config.mcpServers), ['cortex-manager-qa']);
  assert.deepEqual(
    config.mcpServers['cortex-manager-qa'].args,
    ['/test/server/dist/domain/mcp/manager-qa-server.js'],
  );
  assert.equal(config.mcpServers['cortex-manager-qa'].cwd, '/test/server');
});

test('buildThreadConfig returns only cortex-thread', () => {
  const config = buildThreadConfig('/test/server') as any;
  assert.deepEqual(Object.keys(config.mcpServers), ['cortex-thread']);
  assert.deepEqual(
    config.mcpServers['cortex-thread'].args,
    ['/test/server/dist/domain/mcp/thread-server.js'],
  );
  assert.equal(config.mcpServers['cortex-thread'].cwd, '/test/server');
});

// ─── buildTuiConfig ─────────────────────────────────────────────

test('buildTuiConfig returns only cortex-tui-bridge server', () => {
  const config = buildTuiConfig('/test/server') as any;
  assert.ok(config.mcpServers);
  const keys = Object.keys(config.mcpServers);
  assert.equal(keys.length, 1, 'TUI config must isolate to a single bridge server');
  assert.ok(keys.includes('cortex-tui-bridge'));
  // Must NOT leak core/ext servers
  assert.ok(!keys.includes('cortex-core'), 'TUI config must not include cortex-core');
  assert.ok(!keys.includes('cortex-ext'), 'TUI config must not include cortex-ext');
});

test('buildTuiConfig points to tui-server.js (absolute path)', () => {
  const config = buildTuiConfig('/test') as any;
  assert.equal(config.mcpServers['cortex-tui-bridge'].command, 'node');
  assert.deepEqual(config.mcpServers['cortex-tui-bridge'].args, ['/test/dist/domain/mcp/tui-server.js']);
  assert.equal(config.mcpServers['cortex-tui-bridge'].cwd, '/test');
});

// ─── buildFeishuConfig (Feishu-originated sessions) ─────────────

test('buildFeishuConfig returns only the cortex-feishu server', () => {
  const config = buildFeishuConfig('/test/server') as any;
  assert.ok(config.mcpServers);
  const keys = Object.keys(config.mcpServers);
  assert.equal(keys.length, 1, 'feishu config must isolate to a single server (layered on top of the base config)');
  assert.ok(keys.includes('cortex-feishu'));
  // Must NOT duplicate core/ext — those come from the base config it layers onto.
  assert.ok(!keys.includes('cortex-core'), 'feishu config must not include cortex-core');
  assert.ok(!keys.includes('cortex-ext'), 'feishu config must not include cortex-ext');
});

test('buildFeishuConfig points to feishu-server.js (absolute path)', () => {
  const config = buildFeishuConfig('/test') as any;
  assert.equal(config.mcpServers['cortex-feishu'].command, 'node');
  assert.deepEqual(config.mcpServers['cortex-feishu'].args, ['/test/dist/domain/mcp/feishu-server.js']);
  assert.equal(config.mcpServers['cortex-feishu'].cwd, '/test');
});

// ─── buildWebConfig (Web-UI-originated sessions) ─────────────

test('buildWebConfig returns only the cortex-web server', () => {
  const config = buildWebConfig('/test/server') as any;
  assert.ok(config.mcpServers);
  const keys = Object.keys(config.mcpServers);
  assert.equal(keys.length, 1, 'web config must isolate to a single server (layered on top of the base config)');
  assert.ok(keys.includes('cortex-web'));
  assert.ok(!keys.includes('cortex-core'), 'web config must not include cortex-core');
  assert.ok(!keys.includes('cortex-ext'), 'web config must not include cortex-ext');
});

test('buildWebConfig points to web-server.js (absolute path)', () => {
  const config = buildWebConfig('/test') as any;
  assert.equal(config.mcpServers['cortex-web'].command, 'node');
  assert.deepEqual(config.mcpServers['cortex-web'].args, ['/test/dist/domain/mcp/web-server.js']);
  assert.equal(config.mcpServers['cortex-web'].cwd, '/test');
});
