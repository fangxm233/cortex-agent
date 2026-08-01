// input:  optional run-config files, resolved profiles, MCP declarations
// output: closed-schema, route, role, and restricted-surface proofs
// pos:    One-shot configuration boundary regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import {
  loadAgentRunConfig, resolvedRouteHost, validateResolvedExecution,
} from '../../../src/domain/agent-run/run-config.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-config-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeRunConfig(
  mcpComposition: 'none' | 'benchmark-thread-run',
  mcpFile: string,
  additions: Record<string, unknown> = {},
): string {
  const file = path.join(root, 'run-config.json');
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 'cortex-agent-run-config/1',
    model_execution: { model_alias_policy: { kind: 'exact' } },
    role: {
      system_prompt: '',
      tools: ['Bash'],
      plugin_dirs: [],
      mcp_composition: mcpComposition,
      mcp_config_paths: [path.basename(mcpFile)],
      disable_hooks: true,
    },
    bundle: {
      run_config: { fixture: true },
      limits: {},
      adapter_hashes: { adapter: 'fixture' },
      harness_hashes: null,
    },
    ...additions,
  }));
  return file;
}

function fixtureProfile() {
  return {
    name: 'fixture', model: 'model', backend: 'claude' as const, mode: null,
    provider: 'anthropic',
    extraEnv: { ANTHROPIC_BASE_URL: 'https://route.example/v1' } as Record<string, string>,
    extraOption: {} as Record<string, string>,
    claudeBackend: 'print' as const, thinking: null, fallback: [],
  };
}

it('uses one neutral role when no run config is supplied', () => {
  const config = loadAgentRunConfig();
  assert.equal(config.modelExecution.modelAliasPolicy, null);
  assert.equal(config.role.systemPrompt, '');
  assert.ok(config.role.tools.includes('Bash'));
  assert.deepEqual(config.role.pluginDirs, []);
  assert.equal(config.role.mcpComposition, 'none');
  assert.equal(config.role.disableHooks, true);
  assert.equal(config.runConfig, null);
  assert.equal(config.limits, null);
  assert.equal(config.adapterHashes, null);
  assert.equal(config.harnessHashes, null);
});

it('resolves one role independently of the agent-slot label', () => {
  const mcpFile = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  const config = loadAgentRunConfig(writeRunConfig('none', mcpFile));
  assert.deepEqual(config.role.tools, ['Bash']);
  assert.deepEqual(config.role.mcpConfigPaths, [mcpFile]);
  assert.deepEqual(config.adapterHashes, { adapter: 'fixture' });
});

it('derives the route host and rejects late CLI option overrides', () => {
  const mcpFile = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  const config = loadAgentRunConfig(writeRunConfig('none', mcpFile));
  const profile = fixtureProfile();
  assert.equal(resolvedRouteHost(profile), 'route.example');
  profile.extraEnv = {};
  assert.equal(resolvedRouteHost(profile), null);
  profile.extraOption = { '--model': 'different-model' };
  assert.throws(() => validateResolvedExecution(profile, config), /may not override --model/);
});

it('requires one-shot hooks to stay disabled', () => {
  const mcpFile = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  const file = writeRunConfig('none', mcpFile);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.role.disable_hooks = false;
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => loadAgentRunConfig(file), /disable_hooks/i);
});

it('rejects unknown run-config keys', () => {
  const mcpFile = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  assert.throws(
    () => loadAgentRunConfig(writeRunConfig('none', mcpFile, { unknown: true })),
    /unrecognized|unknown/i,
  );
});

it('rejects ambient servers in the none composition', () => {
  const mcpFile = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { ambient: { command: 'false' } } }));
  assert.throws(
    () => loadAgentRunConfig(writeRunConfig('none', mcpFile)),
    /none composition must expose zero MCP servers/,
  );
});

it('accepts exactly the benchmark server in the benchmark composition', () => {
  const mcpFile = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: { 'cortex-benchmark-thread': { command: 'fixture' } },
  }));
  const config = loadAgentRunConfig(writeRunConfig('benchmark-thread-run', mcpFile));
  assert.deepEqual(config.role.mcpConfigPaths, [mcpFile]);
});
