import { expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { getDefaultSelection, listFavorites } from '../../../src/domain/agents/models.js';
import { modelsRepo, MODELS_FILE } from '../../../src/store/models-repo.js';

const selection = { model: 'opus', backend: 'claude', provider: null, thinking: null, mode: 'plan' };
test('loaded selections and model refs do not expose retired or foreign fields', () => {
  const extra = { claudeBackend: 'tui', extraEnv: { TEST: 'x' }, extraOption: { '--effort': 'max' }, maxOutputTokens: 4096, fallback: [] };
  writeFileSync(MODELS_FILE, JSON.stringify({ default: { ...selection, ...extra }, favorites: [{ ...selection, ...extra }] }));
  modelsRepo.invalidate();
  expect(getDefaultSelection()).toEqual(selection);
  expect(listFavorites()).toEqual([{ model: 'opus', backend: 'claude', provider: null }]);
});
