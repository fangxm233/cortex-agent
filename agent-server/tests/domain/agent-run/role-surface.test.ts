// input:  prepared spawn configs and temporary plugin trees
// output: content hashing and argv anti-divergence proofs
// pos:    Regression tests for exact one-shot role identity
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import { buildSpawnArgs } from '../../../src/agent-adapter/claude/spawn-args.js';
import type { AgentSpawnConfig } from '../../../src/agent-adapter/types.js';
import {
  directoryContentSha256, roleSurfaceFromSpawnConfig,
} from '../../../src/domain/agent-run/role-surface.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'role-surface-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function spawnConfig(pluginDirs: string[] = []): AgentSpawnConfig {
  return {
    sessionId: null,
    sessionKey: 'fixture',
    resume: false,
    systemPrompt: 'system fixture',
    rawTools: 'Bash,Read,Write',
    pluginDirs,
    mcpComposition: 'none',
    mcpConfigPaths: [path.join(root, 'empty-mcp.json')],
    disableHooks: true,
  };
}

it('content-addresses plugin files and discovers skill directories', () => {
  const plugin = path.join(root, 'plugin-a');
  const skill = path.join(plugin, 'skills', 'inspect');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'plugin.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Inspect\n');
  const before = directoryContentSha256(plugin);
  const surface = roleSurfaceFromSpawnConfig(spawnConfig([plugin]));
  assert.equal(surface.pluginDirs[0].content_sha256, before);
  assert.deepEqual(surface.skills.map(value => value.name), ['inspect']);
  assert.equal(
    surface.directiveSha256,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  fs.appendFileSync(path.join(skill, 'SKILL.md'), 'changed\n');
  assert.notEqual(directoryContentSha256(plugin), before);
});

it('hashes the exact tools, MCP composition, and hook policy used by Claude argv', () => {
  const config = spawnConfig();
  fs.writeFileSync(config.mcpConfigPaths![0], '{"mcpServers":{}}\n');
  const surface = roleSurfaceFromSpawnConfig(config);
  const args = buildSpawnArgs({
    tools: config.rawTools!,
    systemPrompt: config.systemPrompt,
    pluginDirs: config.pluginDirs,
    needsResume: false,
    sessionId: '00000000-0000-4000-8000-000000000001',
    mcpComposition: config.mcpComposition,
    mcpConfigPaths: config.mcpConfigPaths,
    disableHooks: config.disableHooks,
    streamDeltas: false,
  });
  const toolsIndex = args.indexOf('--tools');
  assert.deepEqual(args[toolsIndex + 1].split(','), surface.tools);
  assert.equal(surface.mcpComposition, 'none');
  assert.deepEqual(args.slice(args.indexOf('--mcp-config'), args.indexOf('--strict-mcp-config')), [
    '--mcp-config', config.mcpConfigPaths![0],
  ]);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.hooks, {});
  assert.deepEqual(surface.hookPolicy, settings.hooks);
});

it('orders plugin and skill identities independently of config order', () => {
  const first = path.join(root, 'z-plugin');
  const second = path.join(root, 'a-plugin');
  fs.mkdirSync(path.join(first, 'skills', 'z-skill'), { recursive: true });
  fs.mkdirSync(path.join(second, 'skills', 'a-skill'), { recursive: true });
  fs.writeFileSync(path.join(first, 'skills', 'z-skill', 'SKILL.md'), 'z\n');
  fs.writeFileSync(path.join(second, 'skills', 'a-skill', 'SKILL.md'), 'a\n');
  const forward = roleSurfaceFromSpawnConfig(spawnConfig([first, second]));
  const reverse = roleSurfaceFromSpawnConfig(spawnConfig([second, first]));
  assert.deepEqual(forward.pluginDirs, reverse.pluginDirs);
  assert.deepEqual(forward.skills, reverse.skills);
  assert.deepEqual(forward.pluginDirs.map(value => value.path), [second, first]);
  assert.deepEqual(forward.skills.map(value => value.name), ['a-skill', 'z-skill']);
});
