// input:  data/agent-state.json and the legacy data/mode.json, in a per-file test home
// output: parse, one-time migration and save-round-trip coverage for the agent selection store
// pos:    P3.1a gate — the rename must not cost a user their profile selection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const STORE = path.join(process.env.CORTEX_HOME!, 'data');
const STATE = path.join(STORE, 'agent-state.json');
const LEGACY = path.join(STORE, 'mode.json');
const BAK = `${LEGACY}.bak`;

function clean() {
  mkdirSync(STORE, { recursive: true });
  for (const f of [STATE, LEGACY, BAK]) rmSync(f, { force: true });
}

/** A fresh module registry per case: the store pins STORE_DIR at import time, and the migration
 *  it performs is exactly a first-import side effect. */
async function freshModule() {
  vi.resetModules();
  return import('../../../src/domain/agents/agent-state.js');
}

afterEach(() => clean());

test('an empty home yields empty state and writes nothing', async () => {
  clean();
  const { loadAgentState } = await freshModule();
  assert.deepEqual(loadAgentState(), {
    activeProfile: null, channelProfiles: {}, defaultAgent: null, channelOverrides: {},
  });
  assert.equal(existsSync(STATE), false, 'a read must not create the file');
});

test('mode.json migrates once: state is carried, the original is kept as .bak', async () => {
  clean();
  writeFileSync(LEGACY, JSON.stringify({
    mode: 'plan', claudeMode: 'plan', backend: 'pi', claudeModel: 'opus',
    activeProfile: 'execute', defaultAgent: 'plan', channelProfiles: { 'web:a': 'execute' },
  }));
  const { loadAgentState } = await freshModule();
  const state = loadAgentState();
  assert.equal(state.activeProfile, 'execute');
  assert.equal(state.defaultAgent, 'plan');
  assert.deepEqual(state.channelProfiles, { 'web:a': 'execute' });
  assert.equal(state.backend, 'pi');
  assert.equal(state.claudeMode, 'plan');
  assert.equal(state.claudeModel, 'opus');
  // The rename is the rollback path AND the evidence the migration ran.
  assert.equal(existsSync(LEGACY), false, 'mode.json must not survive as a second source of truth');
  assert.equal(existsSync(BAK), true);
  assert.deepEqual(JSON.parse(readFileSync(STATE, 'utf8')).channelProfiles, { 'web:a': 'execute' });
  assert.equal(JSON.parse(readFileSync(BAK, 'utf8')).activeProfile, 'execute');
});

test('an existing agent-state.json wins and leaves mode.json alone', async () => {
  clean();
  writeFileSync(STATE, JSON.stringify({ activeProfile: 'new' }));
  writeFileSync(LEGACY, JSON.stringify({ activeProfile: 'old' }));
  const { loadAgentState } = await freshModule();
  assert.equal(loadAgentState().activeProfile, 'new');
  // Migrating a second time could only overwrite newer state with older.
  assert.equal(existsSync(LEGACY), true);
  assert.equal(existsSync(BAK), false);
});

test('the legacy shape that stored the Claude mode only under `mode` still migrates', async () => {
  clean();
  writeFileSync(LEGACY, JSON.stringify({ backend: 'claude', mode: 'api' }));
  const { loadAgentState } = await freshModule();
  assert.equal(loadAgentState().claudeMode, 'api');
});

test('`mode` is ignored when the backend was not claude — it meant something else there', async () => {
  clean();
  writeFileSync(LEGACY, JSON.stringify({ backend: 'pi', mode: 'openai-codex' }));
  const { loadAgentState } = await freshModule();
  assert.equal(loadAgentState().claudeMode, undefined);
});

test('corrupt or foreign values collapse to defaults instead of throwing', async () => {
  clean();
  writeFileSync(STATE, '{ this is not json');
  const { loadAgentState } = await freshModule();
  assert.deepEqual(loadAgentState(), {
    activeProfile: null, channelProfiles: {}, defaultAgent: null, channelOverrides: {},
  });

  clean();
  writeFileSync(STATE, JSON.stringify({
    activeProfile: 42, channelProfiles: { good: 'p', bad: 7 }, defaultAgent: '',
    channelOverrides: { keep: { model: 'sonnet' }, drop: { model: 3 }, empty: {} },
    backend: 'codex',
  }));
  const mod = await freshModule();
  const state = mod.loadAgentState();
  assert.equal(state.activeProfile, null);
  assert.deepEqual(state.channelProfiles, { good: 'p' });
  assert.equal(state.defaultAgent, null);
  assert.deepEqual(state.channelOverrides, { keep: { model: 'sonnet' } });
  assert.equal(state.backend, undefined, 'an unknown backend is not a backend');
});

test('save omits empty fields and round-trips channel overrides', async () => {
  clean();
  const { loadAgentState, saveAgentState } = await freshModule();
  saveAgentState({
    activeProfile: 'execute',
    channelProfiles: {},
    defaultAgent: null,
    channelOverrides: { 'web:a': { model: 'sonnet' } },
    claudeMode: 'plan',
  });
  const written = JSON.parse(readFileSync(STATE, 'utf8'));
  assert.deepEqual(Object.keys(written).sort(), ['activeProfile', 'channelOverrides', 'claudeMode', 'mode'].sort());
  // `mode` is written beside `claudeMode` so a rolled-back build still reads the Claude mode.
  assert.equal(written.mode, 'plan');
  assert.deepEqual(loadAgentState().channelOverrides, { 'web:a': { model: 'sonnet' } });
});
