import { beforeEach, expect, test, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { importWithFreshRegistry } from '../../helpers/fresh-module.js';

const HOME = process.env.CORTEX_HOME!;
const STATE = path.join(HOME, 'data/agent-state.json');
const selection = { backend: 'pi', provider: 'deepseek', model: 'flash', thinking: 'xhigh', mode: 'deepseek' };
let patches: unknown[] = [];
vi.mock('@store/session-registry-repo.js', () => ({ sessionStore: {
  getBoundSessionId: async () => 'session-1',
  getById: async () => ({ sessionId: 'session-1' }),
  updateSession: async (_id: string, patch: unknown) => { patches.push(patch); },
} }));
vi.mock('../../../src/domain/agents/environments/registry.js', () => ({
  getEnvironment: (name: string) => ['main', 'creative'].includes(name) ? { name } : null,
}));
const stored = () => JSON.parse(readFileSync(STATE, 'utf8'));
const fresh = () => importWithFreshRegistry(() => import('../../../src/domain/agents/agent-switch.js'));
beforeEach(() => {
  patches = [];
  writeFileSync(path.join(HOME, 'config/models.json'), JSON.stringify({ default: selection, favorites: [] }));
  writeFileSync(STATE, JSON.stringify({ channelSelections: { 'web:a': selection }, defaultAgent: 'main' }));
});

test('unknown environment refuses without writing state or session', async () => {
  const before = stored();
  expect(await (await fresh()).switchChannelAgent({ channel: 'web:a', name: 'missing' }))
    .toEqual({ ok: false, reason: 'unknown-agent' });
  expect(stored()).toEqual(before);
  expect(patches).toEqual([]);
});

test('environment change never changes engine, even on another backend or with history', async () => {
  expect(await (await fresh()).switchChannelAgent({ channel: 'web:a', name: 'creative' }))
    .toEqual({ ok: true, agentName: 'creative' });
  expect(stored().channelSelections).toEqual({ 'web:a': selection });
  expect(stored().channelAgents).toEqual({ 'web:a': 'creative' });
  expect(patches).toEqual([{ agentName: 'creative' }]);
});

test('clearing follows the global environment and clears only the agent seed', async () => {
  const api = await fresh();
  await api.switchChannelAgent({ channel: 'web:a', name: 'creative' });
  await api.clearChannelAgentSelection('web:a');
  expect(stored().channelAgents).toBeUndefined();
  expect(stored().selectionDefault).toEqual(selection);
  expect(patches.at(-1)).toEqual({ agentName: null });
});

test('web picks seed complete selection and environment; platform picks do not', async () => {
  const api = await fresh();
  await api.switchChannelAgent({ channel: 'web:a', name: 'creative' });
  expect(stored().selectionDefault).toEqual({ ...selection, agentName: 'creative' });
  await api.switchChannelAgent({ channel: 'slack:a', name: 'main' });
  expect(stored().selectionDefault).toEqual({ ...selection, agentName: 'creative' });
});

test('an agent pick preserves an existing composer engine seed', async () => {
  writeFileSync(STATE, JSON.stringify({ selectionDefault: { ...selection, model: 'other' } }));
  await (await fresh()).switchChannelAgent({ channel: 'web:a', name: 'creative' });
  expect(stored().selectionDefault).toEqual({ ...selection, model: 'other', agentName: 'creative' });
});
