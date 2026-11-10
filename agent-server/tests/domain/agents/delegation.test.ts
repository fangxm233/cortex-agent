import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { CONFIG_DIR } from '../../../src/core/paths.js';
import { modelsRepo } from '../../../src/store/models-repo.js';
import {
  checkDelegatedModel, delegableFilter, delegableNames, delegationRules,
} from '../../../src/domain/agents/delegation.js';
import { checkTaskModels } from '../../../src/core/agents/subagent/delegation-policy.js';
import type { CatalogSnapshot } from '../../../src/domain/models/catalog.js';

const MODELS_FILE = `${CONFIG_DIR}/models.json`;

function writeModels(delegation?: unknown): void {
  writeFileSync(MODELS_FILE, JSON.stringify({
    default: { backend: 'claude', provider: null, model: 'claude-opus-5', thinking: null, connection: null },
    favorites: [
      { backend: 'claude', provider: null, model: 'claude-sonnet-5' },
      { backend: 'pi', provider: 'deepseek', model: 'deepseek-flash' },
    ],
    ...(delegation === undefined ? {} : { delegation }),
  }));
  modelsRepo.invalidate();
}

afterEach(() => {
  rmSync(MODELS_FILE, { force: true });
  modelsRepo.invalidate();
});

const refused = (check: Parameters<typeof checkDelegatedModel>[0]): string => {
  try { checkDelegatedModel(check); } catch (error) { return (error as Error).message; }
  return '';
};

test('without a delegation entry, agents may name only the default and favorites', () => {
  writeModels();
  assert.equal(refused({ backend: 'claude', model: 'claude-sonnet-5' }), '');
  assert.equal(refused({ backend: 'claude', model: 'claude-opus-5:high' }), '', 'the default counts, thinking ignored');
  assert.equal(refused({ backend: 'pi', model: 'deepseek/deepseek-flash:low' }), '');
  assert.equal(refused({ backend: 'pi', model: 'deepseek-flash' }), '', 'a bare PI name resolves through favorites');
  const message = refused({ backend: 'pi', model: 'openai/gpt-5-pro' });
  assert.match(message, /"openai\/gpt-5-pro" is not available for delegation/);
  assert.match(message, /claude-opus-5, claude-sonnet-5, deepseek\/deepseek-flash/);
  assert.match(message, /omit model/);
});

test('naming the delegating session\'s own model is the same as inheriting it', () => {
  writeModels();
  const parent = { backend: 'pi' as const, provider: 'openai', model: 'gpt-5-pro' };
  assert.equal(refused({ backend: 'pi', model: 'openai/gpt-5-pro', parent }), '');
  assert.notEqual(refused({ backend: 'claude', model: 'gpt-5-pro', parent }), '', 'another backend is another model');
});

test('deny removes models from the base, allow lists admit by pattern', () => {
  writeModels({ allow: 'favorites', deny: ['claude-opus-*'] });
  assert.notEqual(refused({ backend: 'claude', model: 'claude-opus-5' }), '');
  assert.equal(refused({ backend: 'claude', model: 'claude-sonnet-5' }), '');

  writeModels({ allow: ['openai/*'], deny: ['*-pro'] });
  assert.equal(refused({ backend: 'pi', model: 'openai/gpt-5' }), '');
  assert.notEqual(refused({ backend: 'pi', model: 'openai/gpt-5-pro' }), '');
  assert.notEqual(refused({ backend: 'claude', model: 'claude-sonnet-5' }), '');
});

test('allow all with no deny restricts nothing, nor does a host without models.json', () => {
  writeModels({ allow: 'all' });
  assert.equal(refused({ backend: 'pi', model: 'anything/at-all' }), '');
  rmSync(MODELS_FILE, { force: true });
  modelsRepo.invalidate();
  assert.equal(refused({ backend: 'pi', model: 'anything/at-all' }), '');
  assert.equal(delegableFilter()({ backend: 'pi', provider: 'x', model: 'y' }), true);
});

test('the listed names join the catalog with the configured models, filtered and deduplicated', () => {
  writeModels({ allow: 'all', deny: ['openai/*-pro'] });
  const snapshot = {
    routes: [{ backend: 'pi', provider: 'openai', models: ['gpt-5', 'gpt-5-pro'] }],
  } as unknown as CatalogSnapshot;
  assert.deepEqual(delegableNames(delegationRules(), snapshot),
    ['claude-opus-5', 'claude-sonnet-5', 'deepseek/deepseek-flash', 'openai/gpt-5']);
});

test('a task list is checked up front, on the backend each task runs on', () => {
  const seen: string[] = [];
  checkTaskModels((check) => { seen.push(`${check.backend}:${check.model}`); },
    [{ model: 'a' }, { model: ' ' }, {}, { model: 'b', backend: 'claude' as const }],
    (task) => task.backend ?? 'pi', null);
  assert.deepEqual(seen, ['pi:a', 'claude:b']);
  assert.doesNotThrow(() => checkTaskModels(undefined, [{ model: 'a' }], () => 'pi', null));
});

test('a schedule model is checked only when an agent session writes it', async () => {
  const { checkAgentScheduleModel } = await import('../../../src/domain/scheduling/schedule-selection.js');
  writeModels();
  const selection = { backend: 'pi' as const, provider: 'openai', model: 'gpt-5-pro', thinking: null, connection: null };
  assert.doesNotThrow(() => checkAgentScheduleModel('openai/gpt-5-pro', selection, {}), 'a user at a terminal');
  assert.throws(() => checkAgentScheduleModel('openai/gpt-5-pro', selection, { CORTEX_SESSION_ID: 's1' }),
    /not available for delegation/);
  assert.doesNotThrow(() => checkAgentScheduleModel('openai/gpt-5-pro', selection, {
    CORTEX_SESSION_ID: 's1', CORTEX_BACKEND: 'pi', CORTEX_PROVIDER: 'openai', CORTEX_MODEL: 'gpt-5-pro',
  }), 'the session\'s own model');
  assert.doesNotThrow(() => checkAgentScheduleModel(undefined, undefined, { CORTEX_SESSION_ID: 's1' }));
});
