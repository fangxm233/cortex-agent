import { expect, test, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importWithFreshRegistry } from '../../helpers/fresh-module.js';

vi.mock('../../../src/agent-adapter/pi/discovery.js', () => ({ piProviderDiscovery: { peekModels: () => [] } }));

const STATE = path.join(process.env.CORTEX_HOME!, 'data/agent-state.json');
const claude = { backend: 'claude' as const, provider: null, model: 'opus', thinking: 'high', mode: 'plan' };
const pi = { backend: 'pi' as const, provider: 'deepseek', model: 'flash', thinking: 'xhigh', mode: 'deepseek' };
const migrated = {
  channelSelections: { 'web:a': claude, 'slack:b': pi },
  modelMemory: {
    '["claude",null,"opus"]': { thinking: 'high', mode: 'plan' },
    '["pi","deepseek","flash"]': { thinking: 'xhigh', mode: 'deepseek' },
  },
  defaultAgent: 'main', channelAgents: { 'web:a': 'creative', 'slack:b': 'research' },
  selectionDefault: { ...pi, agentName: 'creative' },
};

test('reload after migration replaces cached legacy state before the first mutation', async () => {
  writeFileSync(STATE, JSON.stringify({ activeProfile: 'old', channelProfiles: { 'web:a': 'old' } }));
  const api = await importWithFreshRegistry(() => import('../../../src/domain/agents/config.js'));
  expect(api.getChannelSelection('web:a')).toBeNull();
  // Startup migration rewrites disk after config.ts has already been imported.
  writeFileSync(STATE, JSON.stringify(migrated));
  api.reloadAgentState();
  expect(api.getChannelSelection('web:a')).toEqual(claude);
  expect(api.getChannelSelection('slack:b')).toEqual(pi);
  expect(api.getModelMemory()).toEqual(migrated.modelMemory);
  expect(api.getSelectionDefault()).toEqual(migrated.selectionDefault);
  api.setDefaultAgent('new-agent', 'web:new');
  expect(JSON.parse(readFileSync(STATE, 'utf8'))).toEqual({
    ...migrated, channelAgents: { ...migrated.channelAgents, 'web:new': 'new-agent' },
  });
});
