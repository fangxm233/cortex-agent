// input:  scoped and bundled MCP config builders
// output: Bundled configs, gates and user MCP isolation tests
// pos:    Config-generator pure-logic tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

function expectedBundled(...bundles: string[]) {
  return {
    command: 'node',
    args: ['/test/dist/domain/mcp/bundled-server.js', JSON.stringify(bundles)],
    cwd: '/test',
  };
}

test('buildFullConfig: always-on direct servers, no cortex-thread', () => {
  assert.deepEqual(buildFullConfig('/test'), {
    mcpServers: {
      'cortex-core': expectedBundled(
        'cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-ext',
      ),
    },
  });
});

test('buildCoreConfig: cortex-core only', () => {
  assert.deepEqual(buildCoreConfig('/test'), {
    mcpServers: { 'cortex-core': expectedBundled('cortex-core') },
  });
});

test('buildTasksConfig: cortex-tasks only', () => {
  assert.deepEqual(buildTasksConfig('/test'), {
    mcpServers: { 'cortex-tasks': expectedBundled('cortex-tasks') },
  });
});

test('buildManagerQaConfig: cortex-manager-qa only', () => {
  assert.deepEqual(buildManagerQaConfig('/test'), {
    mcpServers: { 'cortex-manager-qa': expectedBundled('cortex-manager-qa') },
  });
});

test('buildThreadConfig: complete thread-control composition', () => {
  assert.deepEqual(buildThreadConfig('/test'), {
    mcpServers: {
      'cortex-core': expectedBundled(
        'cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-thread',
      ),
    },
  });
});

test('buildInteractionConfig: interaction bridge only (no core/ext leak)', () => {
  assert.deepEqual(buildInteractionConfig('/test'), {
    mcpServers: { 'cortex-interaction-bridge': expectedBundled('cortex-interaction-bridge') },
  });
});

test('buildFeishuConfig: cortex-feishu only (layered on the base config)', () => {
  assert.deepEqual(buildFeishuConfig('/test'), {
    mcpServers: { 'cortex-feishu': expectedBundled('cortex-feishu') },
  });
});

test('buildWebConfig: cortex-web only (layered on the base config)', () => {
  assert.deepEqual(buildWebConfig('/test'), {
    mcpServers: { 'cortex-web': expectedBundled('cortex-web') },
  });
});

test('materialization collapses Cortex entries and preserves user MCP entries', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const threadPath = path.join(root, 'thread.json');
  const tasksPath = path.join(root, 'tasks.json');
  const userPath = path.join(root, 'user.json');
  writeFileSync(threadPath, JSON.stringify(buildThreadConfig('/test')));
  writeFileSync(tasksPath, JSON.stringify(buildTasksConfig('/test')));
  writeFileSync(userPath, JSON.stringify({
    mcpServers: {
      local_user: { command: '/opt/user-mcp', args: ['--serve'], env: { USER_KEY: 'value' } },
      remote_user: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'secret' } },
    },
  }));

  const generated = materializeMcpToolAllowlistConfigs(
    [threadPath, tasksPath, userPath],
    ['thread_wait', 'task_status', 'thread_wait'],
    path.join(root, 'generated'),
  );
  assert.equal(generated.length, 1);
  assert.equal(statSync(path.dirname(generated[0])).mode & 0o777, 0o700);
  assert.equal(statSync(generated[0]).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(generated[0], 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ['cortex-core', 'local_user', 'remote_user']);
  assert.equal(
    config.mcpServers['cortex-core'].env[MCP_TOOL_ALLOWLIST_ENV],
    JSON.stringify(['task_status', 'thread_wait']),
  );
  assert.equal(
    config.mcpServers['cortex-core'].args[1],
    JSON.stringify(['cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-thread']),
  );
  assert.deepEqual(config.mcpServers.local_user, {
    command: '/opt/user-mcp', args: ['--serve'], env: { USER_KEY: 'value' },
  });
  assert.deepEqual(config.mcpServers.remote_user, {
    type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'secret' },
  });
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

test('dynamic session bundles participate in allowlist validation and config identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const directPath = path.join(root, 'direct.json');
  const outputDir = path.join(root, 'generated');
  writeFileSync(directPath, JSON.stringify(buildFullConfig('/test')));
  const directBundles = ['cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-ext'] as const;
  const interactionBundles = [...directBundles, 'cortex-interaction-bridge'] as const;
  const direct = materializeMcpToolAllowlistConfigs(
    [directPath], ['current_time'], outputDir, directBundles,
  );
  const interaction = materializeMcpToolAllowlistConfigs(
    [directPath], ['cortex_ask_user'], outputDir, interactionBundles,
  );
  assert.notEqual(direct[0], interaction[0]);
  const config = JSON.parse(readFileSync(interaction[0], 'utf8'));
  assert.equal(config.mcpServers['cortex-core'].args[1].includes('cortex-interaction-bridge'), true);
});

test('Windows bundled-server paths are recognized during materialization', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const configPath = path.join(root, 'windows.json');
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'cortex-core': {
        command: 'node',
        args: ['C:\\Cortex\\dist\\domain\\mcp\\bundled-server.js', '["cortex-core"]'],
        cwd: 'C:\\Cortex',
      },
    },
  }));
  const [generated] = materializeMcpToolAllowlistConfigs(
    [configPath], ['current_time'], path.join(root, 'generated'),
  );
  const config = JSON.parse(readFileSync(generated, 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['cortex-core']);
  assert.equal(config.mcpServers['cortex-core'].env[MCP_TOOL_ALLOWLIST_ENV], '["current_time"]');
});
