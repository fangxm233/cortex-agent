import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { importWithFreshRegistry } from '../../helpers/fresh-module.js';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';

const HOME = process.env.CORTEX_HOME!;
const MODELS = path.join(HOME, 'config', 'models.json');
const STATE = path.join(HOME, 'data', 'agent-state.json');
const selection: EngineSelection = { backend: 'claude', provider: null, model: 'claude-opus-5', thinking: 'high', mode: 'plan' };
const other: EngineSelection = { ...selection, model: 'claude-sonnet-5', thinking: 'low' };

function seed(state: Record<string, unknown> = {}): void {
  mkdirSync(path.dirname(MODELS), { recursive: true });
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(MODELS, JSON.stringify({ default: selection, favorites: [selection, other] }));
  writeFileSync(STATE, JSON.stringify(state));
}

function freshLifecycle() {
  return importWithFreshRegistry(() => import('../../../src/domain/sessions/session-lifecycle.js'));
}

function deps() {
  const registered: any[] = [];
  const headers: any[] = [];
  return {
    registered, headers,
    sessionStore: { registerSession: async (record: unknown) => { registered.push(record); } },
    setChannelSession: async () => {},
    initConversation: async (_channel: string, header: unknown) => { headers.push(header); },
    resolveBackend: () => 'claude',
  };
}

function state(): any { return JSON.parse(readFileSync(STATE, 'utf8')); }
beforeEach(() => { rmSync(STATE, { force: true }); });
afterEach(() => { rmSync(STATE, { force: true }); rmSync(MODELS, { force: true }); });

test('a full draft selection is materialized on channel, session, ledger and next draft', async () => {
  seed({ activeProfile: 'obsolete', channelOverrides: { unused: { thinking: 'max' } } });
  const { createDirectSession } = await freshLifecycle();
  const d = deps();
  const { channel } = await createDirectSession(d, { projectId: 'p', selection: other });
  assert.deepEqual(state().channelSelections[channel], other);
  assert.deepEqual(state().selectionDefault, other);
  assert.deepEqual(d.registered[0].selection, other);
  assert.deepEqual(d.headers[0].selection, other);
});

test('resetting a draft to models.default replaces all remembered fields', async () => {
  seed({ selectionDefault: other });
  const { createDirectSession } = await freshLifecycle();
  const { channel } = await createDirectSession(deps(), { projectId: 'p', selection });
  assert.deepEqual(state().channelSelections[channel], selection);
  assert.deepEqual(state().selectionDefault, selection);
});

test('a worker explicit selection does not move the user draft seed', async () => {
  seed({ selectionDefault: other });
  const { createDirectSession } = await freshLifecycle();
  const { channel } = await createDirectSession(deps(), { projectId: 'p', selection, seedDefault: false });
  assert.deepEqual(state().channelSelections[channel], selection);
  assert.deepEqual(state().selectionDefault, other);
});

test('a create without a composer materializes the default and leaves the seed alone', async () => {
  seed({ selectionDefault: other });
  const { createDirectSession } = await freshLifecycle();
  const d = deps();
  await createDirectSession(d, { projectId: 'p' });
  assert.deepEqual(d.registered[0].selection, selection);
  assert.deepEqual(state().selectionDefault, other);
});
