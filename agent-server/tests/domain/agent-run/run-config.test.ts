// input:  legacy/benchmark configs, profiles, MCP declarations
// output: schema dispatch, role, argv, and restricted-surface proofs
// pos:    One-shot configuration boundary regression suite
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, it, vi } from 'vitest';
import {
  loadAgentRunConfig, loadAgentRunConfigWithPolicy,
  resolvedRouteHost, validateResolvedExecution,
} from '../../../src/domain/agent-run/run-config.js';
import { PolicyCompilationError } from '../../../src/domain/benchmark/resolved-policy.js';

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

function expectedLegacyConfig(file: string) {
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    modelExecution: {
      modelAliasPolicy: document.model_execution.model_alias_policy,
      configuredRouteBaseHost: null,
      claudeCliVersion: null,
    },
    role: {
      systemPrompt: document.role.system_prompt,
      tools: document.role.tools,
      pluginDirs: [],
      mcpComposition: document.role.mcp_composition,
      mcpConfigPaths: document.role.mcp_config_paths.map(
        (value: string) => path.resolve(path.dirname(file), value),
      ),
      disableHooks: true,
    },
    runConfig: document.bundle.run_config,
    limits: document.bundle.limits,
    adapterHashes: document.bundle.adapter_hashes,
    harnessHashes: document.bundle.harness_hashes,
  };
}

function isUnknownSchemaFailure(error: unknown): boolean {
  return error instanceof PolicyCompilationError
    && error.code === 44
    && error.reason === 'run_config_schema_unknown'
    && error.failureClass === 'P';
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

it('loads the pre-existing legacy golden config unchanged through the dispatch boundary', () => {
  const file = path.resolve('tests/benchmark-resolved-run-config.golden.json');
  const expected = expectedLegacyConfig(file);
  assert.deepEqual(loadAgentRunConfig(file), expected);
  assert.deepEqual(loadAgentRunConfigWithPolicy({
    runConfigFile: file,
    agentSlot: 'parent',
  }), { config: expected });
});

it('reports absent, non-string, and unknown schema versions as Class-P code 44', () => {
  const stderrLines: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  try {
    const cases = [{}, { schema_version: 1 }, {
      schema_version: 'cortex-agent-run-config/2',
    }];
    for (const [index, value] of cases.entries()) {
      const file = path.join(root, `unknown-${index}.json`);
      fs.writeFileSync(file, JSON.stringify(value));
      assert.throws(
        () => loadAgentRunConfigWithPolicy({ runConfigFile: file, agentSlot: 'parent' }),
        isUnknownSchemaFailure,
      );
    }
  } finally {
    stderr.mockRestore();
  }

  assert.deepEqual(stderrLines.map(line => JSON.parse(line)), Array.from({ length: 3 }, () => ({
    code: 44,
    failure_class: 'P',
    reason: 'run_config_schema_unknown',
  })));
});

it('rejects a recognized benchmark resolution transported through stdin', () => {
  const moduleUrl = pathToFileURL(path.resolve(
    'src/domain/agent-run/run-config.ts',
  )).href;
  const script = `import { loadAgentRunConfigWithPolicy } from '${moduleUrl}';\n`
    + "loadAgentRunConfigWithPolicy({ runConfigFile: '-', agentSlot: 'parent' });";
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', script,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    input: JSON.stringify({ schema_version: 'cortex-benchmark-arm-resolution/1' }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /benchmark arm resolution.*file path/i);
  assert.doesNotMatch(result.stderr, /run_config_schema_unknown|arm_schema_invalid/);
});

it('derives the route host and rejects every profile argv extra', () => {
  const mcpFile = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  const config = loadAgentRunConfig(writeRunConfig('none', mcpFile));
  const profile = fixtureProfile();
  assert.equal(resolvedRouteHost(profile), 'route.example');
  profile.extraEnv = {};
  assert.equal(resolvedRouteHost(profile), null);
  profile.extraOption = { '--permission-mode': 'default' };
  assert.throws(
    () => validateResolvedExecution(profile, config),
    /does not support profile extraOption --permission-mode/,
  );
});

it('rejects an empty role tool list instead of expanding it to Claude defaults', () => {
  const mcpFile = path.join(root, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  const file = writeRunConfig('none', mcpFile);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.role.tools = [];
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => loadAgentRunConfig(file), /role tools must contain at least one tool/i);
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
