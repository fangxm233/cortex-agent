// input:  scoped and gated MCP config builders
// output: builder objects, canonical env gates and unknown-name refusal
// pos:    Config-generator pure-logic tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCoreConfig,
  buildFeishuConfig,
  buildFullConfig,
  buildManagerQaConfig,
  buildTasksConfig,
  buildThreadConfig,
  buildInteractionConfig,
  buildWebConfig,
  materializeMcpToolAllowlistConfigs,
} from '../../src/core/config-generator.js';
import { MCP_TOOL_ALLOWLIST_ENV } from '../../src/core/mcp-tool-gate.js';

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

test('buildInteractionConfig: interaction bridge only (no core/ext leak)', () => {
  assert.deepEqual(buildInteractionConfig('/test'), {
    mcpServers: {
      'cortex-interaction-bridge': {
        command: 'node', args: ['/test/dist/domain/mcp/interaction-server.js'], cwd: '/test',
      },
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

test('materialized configs carry one canonical allowlist across composed servers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const threadPath = path.join(root, 'thread.json');
  const tasksPath = path.join(root, 'tasks.json');
  writeFileSync(threadPath, JSON.stringify(buildThreadConfig('/test')));
  writeFileSync(tasksPath, JSON.stringify(buildTasksConfig('/test')));

  const generated = materializeMcpToolAllowlistConfigs(
    [threadPath, tasksPath],
    ['thread_wait', 'task_status', 'thread_wait'],
    path.join(root, 'generated'),
  );
  const expected = JSON.stringify(['task_status', 'thread_wait']);
  for (const file of generated) {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const entry = Object.values(config.mcpServers)[0] as { env: Record<string, string> };
    assert.equal(entry.env[MCP_TOOL_ALLOWLIST_ENV], expected);
  }
});

test('materialization refuses an allowlist name outside the composed server union', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const threadPath = path.join(root, 'thread.json');
  writeFileSync(threadPath, JSON.stringify(buildThreadConfig('/test')));
  assert.throws(
    () => materializeMcpToolAllowlistConfigs(
      [threadPath], ['thread_wait', 'task_sttaus'], path.join(root, 'generated'),
    ),
    /Unknown MCP tool.*task_sttaus/,
  );
});
