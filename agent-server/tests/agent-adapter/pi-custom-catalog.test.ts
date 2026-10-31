import { engineSpecFixture } from '../engine-spec-fixture.js';


import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { makeFakeRuntimeFactory } from './pi-fake-runtime.js';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { piPool } from './pi-pool-fixture.js';
import { catalogProviderBlocks } from '../../src/agent-adapter/pi/providers-config.js';
import { buildPiCatalog } from '../../src/domain/connections/pi-catalog.js';

const CUSTOM_ENTRY = {
  baseUrl: 'https://llm.example.invalid/v1',
  api: 'anthropic-messages',
  models: [{ id: 'Model-27B' }],
};

const NO_DISCOVERY = {
  getProviders: () => [], refresh: () => {}, getModels: () => [], peekModels: () => [], ensureModels: async () => [],
};

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cortex-pi-custom-catalog-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConnectionsFile(dir: string, connections: unknown[]): string {
  const file = pathJoin(dir, 'connections.json');
  writeFileSync(file, JSON.stringify({ version: 1, connections }));
  return file;
}

/** Open one PI session over a catalog built from `file` and `userModelsPath`; return the written catalog. */
function openWithCatalog(
  dir: string,
  catalog: { file: string; userModelsPath: string | null },
  spec: { sessionKey: string; piProvider: string; model?: string },
): Record<string, any> {
  const agentDir = pathJoin(dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const adapter = new PIAdapter(makeFakeRuntimeFactory().factory, pathJoin(dir, 'sessions'), NO_DISCOVERY, {
    agentDir, catalog: () => buildPiCatalog(catalog),
  });
  piPool(adapter).open(engineSpecFixture({ sessionId: null, resume: false, ...spec }));
  return JSON.parse(readFileSync(pathJoin(agentDir, 'models.json'), 'utf8')).providers;
}

test('catalogProviderBlocks: writes a custom definition verbatim and leaves overrides baseUrl-only', () => {
  const blocks = catalogProviderBlocks({
    providers: { anthropic: { baseUrl: 'https://relay.example.invalid/anthropic' }, 'my-vllm': CUSTOM_ENTRY },
    runtimeKeys: {},
  }, new Set());
  assert.deepEqual(blocks.anthropic, { baseUrl: 'https://relay.example.invalid/anthropic' });
  assert.deepEqual(blocks['my-vllm'], CUSTOM_ENTRY);
});

test('open: a custom provider connection reaches the opened PI catalog complete, at its own URL', () => {
  withTempDir((dir) => {
    const file = writeConnectionsFile(dir, [{
      id: 'my-vllm', backend: 'pi', provider: 'my-vllm', api: 'anthropic-messages',
      baseUrl: 'https://llm.example.invalid/v1', key: 'sk-fake-vllm', models: [{ id: 'Model-27B' }],
    }]);
    const providers = openWithCatalog(dir, { file, userModelsPath: null }, {
      sessionKey: 'custom-provider-spawn', piProvider: 'my-vllm', model: 'Model-27B',
    });
    assert.equal(providers['my-vllm'].api, 'anthropic-messages');
    assert.deepEqual(providers['my-vllm'].models, [{ id: 'Model-27B' }]);
    assert.equal(providers['my-vllm'].baseUrl, 'https://llm.example.invalid/v1');
    assert.equal(providers['my-vllm'].apiKey, 'sk-fake-vllm');
    assert.deepEqual(JSON.parse(readFileSync(pathJoin(dir, 'agent', 'runtime-keys.json'), 'utf8')), { 'my-vllm': 'sk-fake-vllm' });
  });
});

test('open: a user-catalog provider is carried over even when another provider runs', () => {
  withTempDir((dir) => {
    const userModelsPath = pathJoin(dir, 'user-models.json');
    writeFileSync(userModelsPath, JSON.stringify({ providers: { 'my-vllm': CUSTOM_ENTRY } }));
    const providers = openWithCatalog(dir, { file: pathJoin(dir, 'none.json'), userModelsPath }, {
      sessionKey: 'custom-provider-bystander', piProvider: 'anthropic',
    });
    assert.deepEqual(providers['my-vllm'], CUSTOM_ENTRY);
    assert.equal(providers.anthropic, undefined, 'a built-in with no connection keeps PI\'s own URL');
  });
});

test('open: a gateway-era user-catalog block is dropped, not routed to a gateway that no longer serves PI', () => {
  withTempDir((dir) => {
    const userModelsPath = pathJoin(dir, 'user-models.json');
    writeFileSync(userModelsPath, JSON.stringify({ providers: {
      anthropic: { baseUrl: 'http://127.0.0.1:9880/m/plan/anthropic' },
      'old-vllm': { ...CUSTOM_ENTRY, apiKey: 'cortex-gateway' },
    } }));
    const providers = openWithCatalog(dir, { file: pathJoin(dir, 'none.json'), userModelsPath }, {
      sessionKey: 'custom-provider-gateway-era', piProvider: 'anthropic',
    });
    assert.deepEqual(providers, {});
  });
});

test('open: no connections and an absent user catalog leave every built-in provider untouched', () => {
  withTempDir((dir) => {
    const providers = openWithCatalog(dir, { file: pathJoin(dir, 'none.json'), userModelsPath: pathJoin(dir, 'missing.json') }, {
      sessionKey: 'custom-provider-absent', piProvider: 'anthropic',
    });
    assert.deepEqual(providers, {});
  });
});

test('open: DeepSeek child preserves the admitted cap after a model-store refresh', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cortex-pi-cap-refresh-'));
  try {
    const agentDir = pathJoin(dir, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const file = writeConnectionsFile(dir, [
      { id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://relay.example.invalid/ds' },
    ]);
    const stub = makeFakeRuntimeFactory();
    const adapter = new PIAdapter(stub.factory, pathJoin(dir, 'sessions'), NO_DISCOVERY, {
      agentDir, catalog: () => buildPiCatalog({ file, userModelsPath: null }),
    });
    const openSession = (sessionKey: string) => piPool(adapter).open(engineSpecFixture({
      sessionId: null,
      sessionKey,
      resume: false,
      model: 'deepseek-v4-flash',
      piProvider: 'deepseek',
      benchmarkMaxOutputTokens: 65_536,
    }));

    openSession('root-before-refresh');
    writeFileSync(pathJoin(agentDir, 'models-store.json'), JSON.stringify({
      deepseek: {
        checkedAt: Date.now(),
        models: [{
          id: 'deepseek-v4-flash', provider: 'deepseek', api: 'openai-completions',
          compat: { maxTokensField: 'max_tokens' }, maxTokens: 32_768,
        }],
      },
    }));
    openSession('child-after-refresh');

    const catalog = JSON.parse(readFileSync(pathJoin(agentDir, 'models.json'), 'utf8'));
    const deepseek = catalog.providers.deepseek;
    assert.equal(deepseek.compat.maxTokensField, 'max_completion_tokens');
    assert.equal(deepseek.modelOverrides, undefined, 'session caps must not mutate the shared catalog');
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(stub.requests.map(request => request.benchmarkMaxOutputTokens), [65_536, 65_536]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
