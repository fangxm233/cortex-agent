import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG_DIR } from '../../src/core/paths.js';
import { modelsRepo } from '../../src/store/models-repo.js';
import type { EngineSelection } from '../../src/domain/agents/engine-selection.js';

export const CLAUDE_SELECTION: EngineSelection = {
  backend: 'claude', provider: null, model: 'claude-opus-4-6', thinking: null, mode: 'plan',
};
export const PI_SELECTION: EngineSelection = {
  backend: 'pi', provider: 'deepseek', model: 'deepseek-chat', thinking: 'high', mode: 'deepseek',
};

/** Local boundary fixtures do not depend on the full-suite config bootstrap. */
export function seedSelections(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(`${CONFIG_DIR}/models.json`, JSON.stringify({
    default: CLAUDE_SELECTION,
    favorites: [CLAUDE_SELECTION, PI_SELECTION],
  }));
  modelsRepo.invalidate();
}
