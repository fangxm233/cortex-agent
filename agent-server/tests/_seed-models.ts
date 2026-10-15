// Scoped Vitest runs start with an isolated skeleton home. Seed concrete models only
// when a test exercises default selection resolution; never depend on the developer's home.
import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG_DIR } from '../src/core/paths.js';
import type { EngineSelection, ModelsFile } from '../src/domain/agents/engine-selection.js';
import { MODELS_FILE, modelsRepo } from '../src/store/models-repo.js';

export const TEST_CLAUDE_SELECTION: EngineSelection = {
  backend: 'claude', provider: null, model: 'claude-sonnet-4-6', thinking: null, mode: 'plan',
};
export const TEST_PI_SELECTION: EngineSelection = {
  backend: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-6', thinking: 'high', mode: 'anthropic',
};
export const TEST_MODELS: ModelsFile = {
  default: TEST_CLAUDE_SELECTION,
  favorites: [TEST_CLAUDE_SELECTION, TEST_PI_SELECTION].map(({ backend, provider, model }) => ({
    backend, provider, model,
  })),
};

export function seedTestModels(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(MODELS_FILE, JSON.stringify(TEST_MODELS));
  modelsRepo.invalidate();
}
