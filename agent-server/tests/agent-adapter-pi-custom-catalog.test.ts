// input:  provider overrides, PI catalog refresh fixtures, a stub spawner
// output: custom providers and frozen DeepSeek caps in spawned catalogs
// pos:    Unit tests for PI provider routing at spawn time
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { AgentProcessSpawner } from '../src/agent-adapter/types.js';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import {
  buildProviderOverrides,
  withCustomEntries,
  writeProvidersConfig,
} from '../src/agent-adapter/pi/providers-config.js';

function makeStubSpawner(): { spawn: AgentProcessSpawner; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    spawn: () => {
      state.calls += 1;
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      return { process: child as unknown as ChildProcessWithoutNullStreams };
    },
  };
}

const CUSTOM_ENTRY = {
  baseUrl: 'http://127.0.0.1:9880/m/my-vllm/my-vllm',
  api: 'anthropic-messages',
  apiKey: 'cortex-gateway',
  models: [{ id: 'Model-27B' }],
};

test('writeProvidersConfig: writes a custom provider entry verbatim instead of a bare baseUrl', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cortex-pi-custom-catalog-'));
  try {
    const modelsPath = pathJoin(dir, 'models.json');
    writeProvidersConfig(
      [{ name: 'anthropic' }, { name: 'my-vllm', entry: CUSTOM_ENTRY }],
      'http://127.0.0.1:9880',
      { modelsPath },
    );
    const data = JSON.parse(readFileSync(modelsPath, 'utf8'));
    assert.equal(data.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/anthropic');
    assert.equal(data.providers.anthropic.api, undefined, 'built-in overrides stay baseUrl-only');
    assert.deepEqual(data.providers['my-vllm'], CUSTOM_ENTRY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withCustomEntries: attaches definitions only to overrides that have one', () => {
  const overrides = buildProviderOverrides(['anthropic', 'my-vllm'], 'my-vllm', '/m/my-vllm/my-vllm');
  const attached = withCustomEntries(overrides, { 'my-vllm': CUSTOM_ENTRY });
  const byName = new Map(attached.map((o) => [o.name, o]));
  assert.deepEqual(byName.get('my-vllm')?.entry, CUSTOM_ENTRY);
  assert.equal(byName.get('anthropic')?.entry, undefined);
});

test('withCustomEntries: leaves overrides untouched when no definitions are supplied', () => {
  const overrides = buildProviderOverrides(['anthropic'], null, null);
  assert.deepEqual(withCustomEntries(overrides, {}), overrides);
});

test('spawn: a custom provider from the user catalog reaches the spawned PI catalog complete', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cortex-pi-custom-spawn-'));
  try {
    const agentDir = pathJoin(dir, 'agent');
    const userModelsPath = pathJoin(dir, 'user-models.json');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(userModelsPath, JSON.stringify({
      providers: {
        anthropic: { baseUrl: 'http://127.0.0.1:9880/anthropic' },
        'my-vllm': CUSTOM_ENTRY,
      },
    }));

    const stub = makeStubSpawner();
    const adapter = new PIAdapter(
      stub.spawn,
      pathJoin(dir, 'sessions'),
      { getProviders: () => ['anthropic'], refresh: () => {} },
      { agentDir, userModelsPath },
    );

    adapter.spawn({
      sessionId: null,
      sessionKey: 'custom-provider-spawn',
      resume: false,
      model: 'Model-27B',
      piProvider: 'my-vllm',
      piGatewayBaseUrl: 'http://127.0.0.1:9880',
      piGatewayPath: '/m/my-vllm/my-vllm',
    });

    const catalog = JSON.parse(readFileSync(pathJoin(agentDir, 'models.json'), 'utf8'));
    assert.equal(catalog.providers['my-vllm'].api, 'anthropic-messages');
    assert.deepEqual(catalog.providers['my-vllm'].models, [{ id: 'Model-27B' }]);
    assert.equal(catalog.providers['my-vllm'].baseUrl, 'http://127.0.0.1:9880/m/my-vllm/my-vllm');
    assert.equal(catalog.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/anthropic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn: a discovered custom provider is completed even when another provider runs', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cortex-pi-custom-spawn-'));
  try {
    const agentDir = pathJoin(dir, 'agent');
    const userModelsPath = pathJoin(dir, 'user-models.json');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(userModelsPath, JSON.stringify({ providers: { 'my-vllm': CUSTOM_ENTRY } }));

    const stub = makeStubSpawner();
    const adapter = new PIAdapter(
      stub.spawn,
      pathJoin(dir, 'sessions'),
      { getProviders: () => ['anthropic', 'my-vllm'], refresh: () => {} },
      { agentDir, userModelsPath },
    );

    adapter.spawn({
      sessionId: null,
      sessionKey: 'custom-provider-bystander',
      resume: false,
      piProvider: 'anthropic',
      piGatewayBaseUrl: 'http://127.0.0.1:9880',
      piGatewayPath: '/m/plan/anthropic',
    });

    const catalog = JSON.parse(readFileSync(pathJoin(agentDir, 'models.json'), 'utf8'));
    assert.deepEqual(catalog.providers['my-vllm'], CUSTOM_ENTRY);
    assert.equal(catalog.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/m/plan/anthropic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn: an absent user catalog leaves built-in routing untouched', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cortex-pi-custom-spawn-'));
  try {
    const agentDir = pathJoin(dir, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const stub = makeStubSpawner();
    const adapter = new PIAdapter(
      stub.spawn,
      pathJoin(dir, 'sessions'),
      { getProviders: () => ['anthropic'], refresh: () => {} },
      { agentDir, userModelsPath: pathJoin(dir, 'missing.json') },
    );

    adapter.spawn({
      sessionId: null,
      sessionKey: 'custom-provider-absent',
      resume: false,
      piProvider: 'anthropic',
      piGatewayBaseUrl: 'http://127.0.0.1:9880',
    });

    const catalog = JSON.parse(readFileSync(pathJoin(agentDir, 'models.json'), 'utf8'));
    assert.deepEqual(Object.keys(catalog.providers), ['anthropic']);
    assert.equal(catalog.providers.anthropic.api, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn: DeepSeek child preserves the admitted cap after a model-store refresh', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cortex-pi-cap-refresh-'));
  try {
    const agentDir = pathJoin(dir, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const stub = makeStubSpawner();
    const adapter = new PIAdapter(
      stub.spawn,
      pathJoin(dir, 'sessions'),
      { getProviders: () => ['deepseek'], refresh: () => {} },
      { agentDir },
    );
    const spawn = (sessionKey: string) => adapter.spawn({
      sessionId: null,
      sessionKey,
      resume: false,
      model: 'deepseek-v4-flash',
      piProvider: 'deepseek',
      piModelMaxTokens: 65_536,
      piGatewayBaseUrl: 'http://127.0.0.1:9880',
      piGatewayPath: '/deepseek',
    });

    spawn('root-before-refresh');
    writeFileSync(pathJoin(agentDir, 'models-store.json'), JSON.stringify({
      deepseek: {
        checkedAt: Date.now(),
        models: [{
          id: 'deepseek-v4-flash', provider: 'deepseek', api: 'openai-completions',
          compat: { maxTokensField: 'max_tokens' }, maxTokens: 32_768,
        }],
      },
    }));
    spawn('child-after-refresh');

    const catalog = JSON.parse(readFileSync(pathJoin(agentDir, 'models.json'), 'utf8'));
    const deepseek = catalog.providers.deepseek;
    assert.equal(deepseek.compat.maxTokensField, 'max_completion_tokens');
    assert.equal(deepseek.modelOverrides['deepseek-v4-flash'].maxTokens, 65_536);
    assert.equal(stub.calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
