import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { importWithFreshRegistry } from '../../helpers/fresh-module.js';

const STATE = path.join(process.env.CORTEX_HOME!, 'data', 'agent-state.json');
const selection = { backend: 'claude' as const, provider: null, model: 'opus', thinking: null, mode: 'api' };
const empty = { channelSelections: {}, modelMemory: {}, defaultAgent: null, channelAgents: {} };
const fresh = () => importWithFreshRegistry(() => import('../../../src/domain/agents/agent-state.js'));
beforeEach(() => rmSync(STATE, { force: true }));
afterEach(() => rmSync(STATE, { force: true }));

test('an empty home yields empty state and writes nothing', async () => {
  const { loadAgentState } = await fresh();
  assert.deepEqual(loadAgentState(), empty);
  assert.equal(existsSync(STATE), false);
});

test('complete selections, null thinking, billing route, memory and agent seed survive restart', async () => {
  const { loadAgentState, saveAgentState } = await fresh();
  const state = {
    ...empty, defaultAgent: 'main', channelAgents: { 'web:a': 'creative' },
    channelSelections: { 'web:a': selection },
    modelMemory: { '["claude",null,"opus"]': { thinking: null, mode: 'api' } },
    selectionDefault: { ...selection, agentName: 'creative' },
  };
  saveAgentState(state);
  assert.deepEqual(loadAgentState(), state);
  assert.deepEqual((await fresh()).loadAgentState(), state);
});

test('save omits empty maps and does not emit retired fields', async () => {
  const { loadAgentState, saveAgentState } = await fresh();
  writeFileSync(STATE, JSON.stringify({ activeProfile: 'old', channelProfiles: { a: 'old' }, backend: 'pi' }));
  saveAgentState(loadAgentState());
  assert.deepEqual(JSON.parse(readFileSync(STATE, 'utf8')), {});
});

test('malformed state is ignored; valid independent entries survive', async () => {
  writeFileSync(STATE, '{ invalid');
  const { loadAgentState } = await fresh();
  assert.deepEqual(loadAgentState(), empty);
  writeFileSync(STATE, JSON.stringify({
    channelSelections: { good: selection, bad: { model: 'opus' }, invalid: { ...selection, thinking: 'off' } },
    channelAgents: { good: 'creative', bad: 3, empty: '' }, defaultAgent: 5,
    modelMemory: { good: { thinking: null, mode: 'api' }, bad: { mode: 5 } },
    selectionDefault: { model: 'incomplete', agentName: 'creative' },
  }));
  assert.deepEqual(loadAgentState(), {
    ...empty, channelSelections: { good: selection }, channelAgents: { good: 'creative' },
    modelMemory: { good: { thinking: null, mode: 'api' } },
  });
});

test('a PI selection requires a provider; Claude cannot carry one', async () => {
  writeFileSync(STATE, JSON.stringify({ channelSelections: {
    pi: { ...selection, backend: 'pi' }, claude: { ...selection, provider: 'deepseek' },
  } }));
  assert.deepEqual((await fresh()).loadAgentState().channelSelections, {});
});
