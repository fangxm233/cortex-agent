// input:  scoped MCP config builders
// output: whole-object contract per builder (keys, command, absolute args, cwd)
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

// Each builder is asserted as ONE whole-object literal: this pins the server
// set (isolation/no-leak per the privilege split), the node command, the
// absolute dist path in args (cwd is NOT inherited by spawned MCP processes —
// see serverEntry in config-generator.ts), and the cwd, in a single equality.

test('buildFullConfig: always-on direct servers, no cortex-thread', () => {
  assert.deepEqual(buildFullConfig('/test'), {
    mcpServers: {
      'cortex-core': { command: 'node', args: ['/test/dist/domain/mcp/core-server.js'], cwd: '/test' },
      'cortex-tasks': { command: 'node', args: ['/test/dist/domain/mcp/tasks-server.js'], cwd: '/test' },
      'cortex-manager-qa': { command: 'node', args: ['/test/dist/domain/mcp/manager-qa-server.js'], cwd: '/test' },
      'cortex-ext': { command: 'node', args: ['/test/dist/domain/mcp/server.js'], cwd: '/test' },
    },
  });
});

test('buildCoreConfig: cortex-core only', () => {
  assert.deepEqual(buildCoreConfig('/test'), {
    mcpServers: {
      'cortex-core': { command: 'node', args: ['/test/dist/domain/mcp/core-server.js'], cwd: '/test' },
    },
  });
});

test('buildTasksConfig: cortex-tasks only', () => {
  assert.deepEqual(buildTasksConfig('/test'), {
    mcpServers: {
      'cortex-tasks': { command: 'node', args: ['/test/dist/domain/mcp/tasks-server.js'], cwd: '/test' },
    },
  });
});

test('buildManagerQaConfig: cortex-manager-qa only', () => {
  assert.deepEqual(buildManagerQaConfig('/test'), {
    mcpServers: {
      'cortex-manager-qa': { command: 'node', args: ['/test/dist/domain/mcp/manager-qa-server.js'], cwd: '/test' },
    },
  });
});

test('buildThreadConfig: cortex-thread only (thread sessions)', () => {
  assert.deepEqual(buildThreadConfig('/test'), {
    mcpServers: {
      'cortex-thread': { command: 'node', args: ['/test/dist/domain/mcp/thread-server.js'], cwd: '/test' },
    },
  });
});

test('buildTuiConfig: cortex-tui-bridge only (no core/ext leak)', () => {
  assert.deepEqual(buildTuiConfig('/test'), {
    mcpServers: {
      'cortex-tui-bridge': { command: 'node', args: ['/test/dist/domain/mcp/tui-server.js'], cwd: '/test' },
    },
  });
});

test('buildFeishuConfig: cortex-feishu only (layered on the base config)', () => {
  assert.deepEqual(buildFeishuConfig('/test'), {
    mcpServers: {
      'cortex-feishu': { command: 'node', args: ['/test/dist/domain/mcp/feishu-server.js'], cwd: '/test' },
    },
  });
});

test('buildWebConfig: cortex-web only (layered on the base config)', () => {
  assert.deepEqual(buildWebConfig('/test'), {
    mcpServers: {
      'cortex-web': { command: 'node', args: ['/test/dist/domain/mcp/web-server.js'], cwd: '/test' },
    },
  });
});
