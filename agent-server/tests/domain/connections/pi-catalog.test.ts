import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeConnections } from '../../../src/core/connections-file.js';
import { buildPiCatalog, isGatewayEraBlock } from '../../../src/domain/connections/pi-catalog.js';
import {
  applyRuntimeKeys, catalogProviderBlocks, readRuntimeKeys, writeProviderCatalog,
} from '../../../src/agent-adapter/pi/providers-config.js';

let dir: string;
const file = () => path.join(dir, 'connections.json');
const userModels = () => path.join(dir, 'user-models.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-'));
  fs.writeFileSync(userModels(), JSON.stringify({ providers: {
    mine: { api: 'openai-completions', baseUrl: 'https://mine.example.com/v1', apiKey: 'fake-own-key', models: [{ id: 'm1' }] },
    stale: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9880/m/stale/stale', apiKey: 'cortex-gateway', models: [] },
    deepseek: { baseUrl: 'https://user-choice.example.com' },
  } }));
  writeConnections([
    { id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://deepseek-relay.example.com', key: 'fake-relay-token' },
    { id: 'openai', backend: 'pi', provider: 'openai', baseUrl: 'https://proxy.example.com/v1' },
    { id: 'local', backend: 'pi', provider: 'local', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8102',
      key: 'fake-local-key', models: [{ id: 'q1', contextWindow: 8192 }], compat: { supportsDeveloperRole: false } },
    { id: 'relay', backend: 'claude', label: 'relay', authStyle: 'x-api-key', key: 'fake-claude-key', billing: 'metered' },
  ], file());
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('buildPiCatalog', () => {
  it('writes no key for an account\'s own provider into the account\'s catalog', () => {
    const catalog = buildPiCatalog({ file: file(), userModelsPath: userModels(), accountProvider: 'deepseek' });
    expect(catalog.providers.deepseek).toEqual({ baseUrl: 'https://deepseek-relay.example.com' });
    expect(catalog.runtimeKeys).toEqual({ local: 'fake-local-key' });
    expect(buildPiCatalog({ file: file(), userModelsPath: userModels(), accountProvider: 'mine' }).providers.mine)
      .not.toHaveProperty('apiKey');
  });

  it('writes only what connections change, over the user\'s own catalog minus gateway-era entries', () => {
    const catalog = buildPiCatalog({ file: file(), userModelsPath: userModels() });
    expect(Object.keys(catalog.providers).sort()).toEqual(['deepseek', 'local', 'mine', 'openai']);
    expect(catalog.providers.deepseek).toEqual({ baseUrl: 'https://deepseek-relay.example.com', apiKey: 'fake-relay-token' });
    expect(catalog.providers.openai).toEqual({ baseUrl: 'https://proxy.example.com/v1' });
    expect(catalog.providers.local).toEqual({ baseUrl: 'http://127.0.0.1:8102', apiKey: 'fake-local-key',
      api: 'anthropic-messages', models: [{ id: 'q1', contextWindow: 8192 }], compat: { supportsDeveloperRole: false } });
    expect(catalog.runtimeKeys).toEqual({ deepseek: 'fake-relay-token', local: 'fake-local-key' });
  });

  it('carries nothing over when told there is no user catalog', () => {
    expect(Object.keys(buildPiCatalog({ file: file(), userModelsPath: null }).providers).sort())
      .toEqual(['deepseek', 'local', 'openai']);
  });

  it('recognises what the gateway era wrote', () => {
    expect(isGatewayEraBlock({ apiKey: 'cortex-gateway' })).toBe(true);
    expect(isGatewayEraBlock({ baseUrl: 'http://localhost:9880/m/x/y' })).toBe(true);
    expect(isGatewayEraBlock({ baseUrl: 'https://mine.example.com/v1' })).toBe(false);
  });
});

describe('the catalog a PI agent dir runs with', () => {
  it('adds the compat flags a relayed built-in provider can no longer be detected by', () => {
    const blocks = catalogProviderBlocks({ providers: {
      deepseek: { baseUrl: 'https://deepseek-relay.example.com', compat: { maxTokensField: 'max_tokens', extra: true } },
      openai: { baseUrl: 'https://proxy.example.com/v1' },
      local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:8000/v1', models: [{ id: 'm' }] },
    }, runtimeKeys: {} }, new Set(['openai']));
    expect(blocks.deepseek.compat).toEqual({ supportsDeveloperRole: false, maxTokensField: 'max_tokens', extra: true });
    expect(blocks.openai.compat).toEqual({ supportsMidConvoEffort: false, supportsLongCacheRetention: false });
    expect(blocks.local).not.toHaveProperty('compat');
  });

  it('writes models.json and the runtime keys owner-only, and installs the keys on a runtime', async () => {
    const agentDir = path.join(dir, 'agent');
    writeProviderCatalog({ providers: { deepseek: { baseUrl: 'https://deepseek-relay.example.com', apiKey: 'fake-k' } },
      runtimeKeys: { deepseek: 'fake-k' } }, { agentDir, oauthProviders: new Set() });
    for (const name of ['models.json', 'runtime-keys.json']) {
      expect(fs.statSync(path.join(agentDir, name)).mode & 0o777).toBe(0o600);
    }
    expect(readRuntimeKeys(agentDir)).toEqual({ deepseek: 'fake-k' });
    const runtime = { setRuntimeApiKey: vi.fn(async () => {}) };
    await applyRuntimeKeys(runtime, agentDir);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('deepseek', 'fake-k');
  });

  it('reads missing or malformed runtime keys as none', () => {
    expect(readRuntimeKeys(path.join(dir, 'nowhere'))).toEqual({});
    fs.writeFileSync(path.join(dir, 'runtime-keys.json'), JSON.stringify({ a: '', b: 5, c: 'fake-c' }));
    expect(readRuntimeKeys(dir)).toEqual({ c: 'fake-c' });
  });
});
