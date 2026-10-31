import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, vi } from 'vitest';

const piSdkMock = vi.hoisted(() => ({ create: vi.fn(), loadPiSdk: vi.fn() }));
vi.mock('../../src/core/pi-sdk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/pi-sdk.js')>();
  return { ...actual, loadPiSdk: piSdkMock.loadPiSdk };
});

import { piModelThinkingLevels, scanAgentDirModels } from '../../src/agent-adapter/pi/model-scan.js';

function stubRuntime(available: unknown[], keys: Array<[string, string]>): void {
  piSdkMock.create.mockReset();
  piSdkMock.create.mockResolvedValue({
    getAvailable: async () => available,
    setRuntimeApiKey: async (provider: string, key: string) => { keys.push([provider, key]); },
  });
  piSdkMock.loadPiSdk.mockResolvedValue({ ModelRuntime: { create: piSdkMock.create } });
}

test('an agent dir scan reads that dir\'s auth and catalog with its runtime keys installed', async () => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), 'pi-model-scan-'));
  writeFileSync(path.join(agentDir, 'runtime-keys.json'), JSON.stringify({ deepseek: 'relay-token' }));
  const keys: Array<[string, string]> = [];
  stubRuntime([
    { provider: 'deepseek', id: 'deepseek-chat', reasoning: false },
    { provider: 'my-llm', id: 'local-27b', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } },
    { provider: 'openai', id: 'gpt-x' },
  ], keys);

  const models = await scanAgentDirModels(agentDir);

  assert.deepEqual(piSdkMock.create.mock.calls, [[{
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    allowModelNetwork: false,
  }]]);
  assert.deepEqual(keys, [['deepseek', 'relay-token']]);
  assert.deepEqual(models, [
    { provider: 'deepseek', model: 'deepseek-chat', thinkingLevels: [] },
    { provider: 'my-llm', model: 'local-27b', thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    { provider: 'openai', model: 'gpt-x' },
  ]);
});

test('thinking levels: none for a non-reasoning model, unknown without either field', () => {
  assert.deepEqual(piModelThinkingLevels({ reasoning: false }), []);
  assert.equal(piModelThinkingLevels({ id: 'x' }), undefined);
  assert.deepEqual(piModelThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null } }),
    ['off', 'low', 'medium', 'high']);
});
