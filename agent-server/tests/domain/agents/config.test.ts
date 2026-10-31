import { beforeEach, expect, test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importWithFreshRegistry } from '../../helpers/fresh-module.js';

const HOME = process.env.CORTEX_HOME!;
const STATE = path.join(HOME, 'data/agent-state.json');
const selection = { backend: 'claude' as const, provider: null, model: 'opus', thinking: null, connection: 'api' };
const pi = { backend: 'pi' as const, provider: 'deepseek', model: 'flash', thinking: 'xhigh', connection: null };
const fresh = () => importWithFreshRegistry(() => import('../../../src/domain/agents/config.js'));
beforeEach(() => {
  writeFileSync(STATE, '{}');
  writeFileSync(path.join(HOME, 'config/models.json'), JSON.stringify({ default: selection, favorites: [pi] }));
});

test('channel selections are independent, defensive and persist after reload', async () => {
  const api = await fresh();
  api.setChannelSelection('web:a', selection);
  api.setChannelSelection('web:b', pi);
  const copy = api.getChannelSelection('web:a')!;
  copy.model = 'not-persisted';
  expect(api.getChannelSelection('web:a')).toEqual(selection);
  expect((await fresh()).getChannelSelection('web:b')).toEqual(pi);
  api.clearChannelSelection('web:a');
  expect(api.getChannelSelection('web:a')).toBeNull();
  expect(api.getChannelSelection('web:b')).toEqual(pi);
});

test('model memory is keyed by model identity, keeps only thinking, and copies input and output', async () => {
  const api = await fresh();
  api.rememberModelSelection(selection);
  const key = '["claude",null,"opus"]';
  api.getModelMemory()[key].thinking = 'not-persisted';
  expect(api.getModelMemory()[key]).toEqual({ thinking: null });
  api.rememberModelSelection({ ...selection, thinking: 'high', connection: 'subscription' });
  expect((await fresh()).getModelMemory()[key]).toEqual({ thinking: 'high' });
});

test('older model memory that also carried a connection is read as thinking and written back without it', async () => {
  writeFileSync(STATE, JSON.stringify({ modelMemory: {
    '["claude",null,"opus"]': { thinking: 'low', connection: 'api' },
    '["claude",null,"sonnet"]': { thinking: null, connection: 'removed' },
  } }));
  const api = await fresh();
  expect(api.getModelMemory()).toEqual({ '["claude",null,"opus"]': { thinking: 'low' }, '["claude",null,"sonnet"]': { thinking: null } });
  api.rememberModelSelection({ ...selection, model: 'haiku', thinking: 'high' });
  expect(JSON.parse(readFileSync(STATE, 'utf8')).modelMemory).toEqual({
    '["claude",null,"opus"]': { thinking: 'low' },
    '["claude",null,"sonnet"]': { thinking: null },
    '["claude",null,"haiku"]': { thinking: 'high' },
  });
});

test('seed preserves agent during engine picks, clears agent independently and clears entirely on null', async () => {
  const api = await fresh();
  api.setSelectionDefaultAgent('creative');
  expect(api.getSelectionDefault()).toEqual({ ...selection, agentName: 'creative' });
  api.setSelectionDefault(pi);
  expect(api.getSelectionDefault()).toEqual({ ...pi, agentName: 'creative' });
  api.setSelectionDefaultAgent(null);
  expect(api.getSelectionDefault()).toEqual(pi);
  api.getSelectionDefault()!.model = 'not-persisted';
  expect(api.getSelectionDefault()).toEqual(pi);
  api.setSelectionDefault(null);
  expect(api.getSelectionDefault()).toBeNull();
  expect((await fresh()).getSelectionDefault()).toBeNull();
});

test('agent defaults and per-channel choices remain independent of engine selections', async () => {
  const api = await fresh();
  api.setDefaultAgent('main');
  api.setDefaultAgent('creative', 'web:a');
  api.setChannelSelection('web:a', pi);
  expect(api.getDefaultAgent('web:a')).toBe('creative');
  expect(api.getDefaultAgent('web:b')).toBe('main');
  api.clearChannelAgent('web:a');
  expect(api.getDefaultAgent('web:a')).toBe('main');
  expect(api.getChannelSelection('web:a')).toEqual(pi);
  expect(api.getChannelAgents()).toEqual({});
});

test('backend and Claude-model conveniences read selections rather than retired globals', async () => {
  writeFileSync(STATE, JSON.stringify({ backend: 'pi', activeProfile: 'old' }));
  const api = await fresh();
  expect(api.resolveBackendForChannel()).toBe('claude');
  expect(api.defaultClaudeModel()).toBe('opus');
  api.setChannelSelection('web:a', pi);
  expect(api.resolveBackendForChannel('web:a')).toBe('pi');
  expect(api.resolveBackendForChannel('web:b')).toBe('claude');
  expect(JSON.parse(readFileSync(STATE, 'utf8'))).not.toHaveProperty('activeProfile');
});
