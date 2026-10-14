import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildFullConfig,
  buildCoreConfig,
  buildInteractionConfig,
  materializeMcpToolAllowlistConfigs,
} from '../../src/core/config-generator.js';
import {
  MCP_TOOLS_BY_SERVER,
  MCP_TOOL_ALLOWLIST_ENV,
  registerGatedMcpTools,
} from '../../src/core/mcp-tool-gate.js';

function expectedBundled(...bundles: string[]) {
  return {
    command: 'node',
    args: ['/test/dist/domain/mcp/bundled-server.js', JSON.stringify(bundles)],
    cwd: '/test',
  };
}

test('buildFullConfig: the direct surface is the core and ext bundles', () => {
  assert.deepEqual(buildFullConfig('/test'), {
    mcpServers: { 'cortex-core': expectedBundled('cortex-core', 'cortex-ext') },
  });
});

test('buildInteractionConfig: interaction bridge only (no core/ext leak)', () => {
  assert.deepEqual(buildInteractionConfig('/test'), {
    mcpServers: { 'cortex-interaction-bridge': expectedBundled('cortex-interaction-bridge') },
  });
});

const DIRECT_BUNDLES = ['cortex-core', 'cortex-ext'] as const;

test('materialization collapses Cortex entries and preserves user MCP entries', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const fullPath = path.join(root, 'full.json');
  const corePath = path.join(root, 'core.json');
  const userPath = path.join(root, 'user.json');
  writeFileSync(fullPath, JSON.stringify(buildFullConfig('/test')));
  writeFileSync(corePath, JSON.stringify(buildCoreConfig('/test')));
  writeFileSync(userPath, JSON.stringify({
    mcpServers: {
      local_user: { command: '/opt/user-mcp', args: ['--serve'], env: { USER_KEY: 'value' } },
      remote_user: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'secret' } },
    },
  }));

  const generated = materializeMcpToolAllowlistConfigs(
    [fullPath, corePath, userPath],
    ['current_time', 'cost_query', 'current_time'],
    path.join(root, 'generated'),
    DIRECT_BUNDLES,
  );
  assert.equal(generated.length, 1);
  assert.equal(statSync(path.dirname(generated[0])).mode & 0o777, 0o700);
  assert.equal(statSync(generated[0]).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(generated[0], 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ['cortex-core', 'local_user', 'remote_user']);
  assert.equal(
    config.mcpServers['cortex-core'].env[MCP_TOOL_ALLOWLIST_ENV],
    JSON.stringify(['cost_query', 'current_time']),
  );
  assert.equal(
    config.mcpServers['cortex-core'].args[1],
    JSON.stringify(['cortex-core', 'cortex-ext']),
  );
  assert.deepEqual(config.mcpServers.local_user, {
    command: '/opt/user-mcp', args: ['--serve'], env: { USER_KEY: 'value' },
  });
  assert.deepEqual(config.mcpServers.remote_user, {
    type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'secret' },
  });
});

test('materialization refuses an allowlist name that exists in no bundle at all', () => {
  // Typo protection, and only that: nothing would ever register under `curent_time`, on any surface.
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const fullPath = path.join(root, 'full.json');
  writeFileSync(fullPath, JSON.stringify(buildFullConfig('/test')));
  assert.throws(
    () => materializeMcpToolAllowlistConfigs(
      [fullPath], ['current_time', 'curent_time'], path.join(root, 'generated'), DIRECT_BUNDLES,
    ),
    /Unknown MCP tool.*curent_time/,
  );
});

test('a retired tool name in an old allowlist is dropped, not rejected as a typo', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const fullPath = path.join(root, 'full.json');
  writeFileSync(fullPath, JSON.stringify(buildFullConfig('/test')));
  const [generated] = materializeMcpToolAllowlistConfigs(
    [fullPath], ['current_time', 'task_status', 'ask_manager', 'board_close',
      ...['add', 'list', 'get', 'remove', 'pause', 'resume'].map(name => `cortex_schedule_${name}`)],
    path.join(root, 'generated'), DIRECT_BUNDLES,
  );
  const config = JSON.parse(readFileSync(generated, 'utf8'));
  assert.equal(config.mcpServers['cortex-core'].env[MCP_TOOL_ALLOWLIST_ENV], JSON.stringify(['current_time']));
});

test('an allowlist is an upper bound: a real tool this spawn does not compose is dropped', () => {
  // `send_file` is a real tool of the `cortex-web` bundle. A Slack session composes no such bundle,
  // so the tool is simply absent there — which must narrow the materialized list, not refuse the
  // spawn. Refusing would turn an agent's delivery preference into a rule about which surfaces it
  // is allowed to run on.
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const fullPath = path.join(root, 'full.json');
  writeFileSync(fullPath, JSON.stringify(buildFullConfig('/test')));
  const [generated] = materializeMcpToolAllowlistConfigs(
    [fullPath], ['current_time', 'send_file'], path.join(root, 'generated'), DIRECT_BUNDLES,
  );
  const config = JSON.parse(readFileSync(generated, 'utf8'));
  assert.equal(
    config.mcpServers['cortex-core'].env[MCP_TOOL_ALLOWLIST_ENV],
    JSON.stringify(['current_time']),
  );
});

test('dynamic session bundles participate in allowlist validation and config identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const directPath = path.join(root, 'direct.json');
  const outputDir = path.join(root, 'generated');
  writeFileSync(directPath, JSON.stringify(buildFullConfig('/test')));
  const directBundles = DIRECT_BUNDLES;
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

// A minimal-surface agent (the `creative` environment) keeps the direct composition and narrows it
// with an allowlist instead: delivery plus the one interaction the user can answer. The rest of the
// bridge — plan mode — is loaded as a bundle and must still never register.
const MINIMAL_DELIVERY_SURFACE = ['send_file', 'send_view', 'cortex_ask_user'];

test('a delivery-only allowlist admits one interaction-bridge tool and no other', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-tool-gate-'));
  const directPath = path.join(root, 'direct.json');
  writeFileSync(directPath, JSON.stringify(buildFullConfig('/test')));
  const bundles = ['cortex-core', 'cortex-ext', 'cortex-interaction-bridge', 'cortex-web'] as const;

  const [generated] = materializeMcpToolAllowlistConfigs(
    [directPath], MINIMAL_DELIVERY_SURFACE, path.join(root, 'generated'), bundles,
  );
  const config = JSON.parse(readFileSync(generated, 'utf8'));
  const allowlist = config.mcpServers['cortex-core'].env[MCP_TOOL_ALLOWLIST_ENV];
  assert.equal(allowlist, JSON.stringify(['cortex_ask_user', 'send_file', 'send_view']));
  for (const name of MCP_TOOLS_BY_SERVER['cortex-interaction-bridge']) {
    if (name === 'cortex_ask_user') continue;
    assert.equal(allowlist.includes(name), false, `${name} must not reach the session`);
  }
});

test('the registration gate drops the bridge tools the allowlist omits', () => {
  const registered: string[] = [];
  const server = {
    tool: (name: string) => registered.push(name),
    registerTool: (name: string) => registered.push(name),
  };
  registerGatedMcpTools(
    server as never,
    (target) => {
      for (const name of MCP_TOOLS_BY_SERVER['cortex-interaction-bridge']) {
        (target as unknown as { registerTool: (n: string) => void }).registerTool(name);
      }
    },
    new Set(MINIMAL_DELIVERY_SURFACE),
  );
  assert.deepEqual(registered, ['cortex_ask_user']);
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
    [configPath], ['current_time'], path.join(root, 'generated'), ['cortex-core'],
  );
  const config = JSON.parse(readFileSync(generated, 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['cortex-core']);
  assert.equal(config.mcpServers['cortex-core'].env[MCP_TOOL_ALLOWLIST_ENV], '["current_time"]');
});
