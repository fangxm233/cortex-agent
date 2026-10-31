import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import { modelsRepo } from '../../../src/store/models-repo.js';
import { seedClaudeKeyConnection } from '../../_seed-connections.js';

export const DEFAULT_SELECTION: EngineSelection = {
  backend: 'claude', provider: null, model: 'claude-opus-5', thinking: 'high', connection: 'relay',
};
export const OTHER_SELECTION: EngineSelection = {
  backend: 'pi', provider: 'openai', model: 'gpt-test', thinking: 'medium', connection: null,
};

export function seedScheduleModels(defaultSelection: EngineSelection = DEFAULT_SELECTION): void {
  seedClaudeKeyConnection('relay');
  const dir = path.join(process.env.CORTEX_HOME!, 'config');
  mkdirSync(dir, { recursive: true });
  const favorites = [DEFAULT_SELECTION, OTHER_SELECTION].map(({ backend, provider, model }) => ({ backend, provider, model }));
  writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ default: defaultSelection, favorites }));
  modelsRepo.invalidate();
}
