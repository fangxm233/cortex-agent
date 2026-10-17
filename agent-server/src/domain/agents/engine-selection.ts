import type { Backend } from '@core/types/agent-types.js';

/** A complete, concrete engine choice. Environments are an independent axis. */
export interface EngineSelection {
  backend: Backend;
  provider: string | null;
  model: string;
  thinking: string | null;
  mode: string;
}

export type ModelRef = Pick<EngineSelection, 'backend' | 'provider' | 'model'>;
export interface ModelsFile {
  default: EngineSelection;
  favorites: ModelRef[];
}

export function modelKey(ref: ModelRef): string {
  return JSON.stringify([ref.backend, ref.provider, ref.model]);
}

export const THINKING_LEVELS_BY_BACKEND: Record<Backend, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};

export function isValidThinkingLevel(backend: Backend, level: string): boolean {
  return THINKING_LEVELS_BY_BACKEND[backend]?.includes(level) ?? false;
}

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

export function validateModelRef(value: unknown): asserts value is ModelRef {
  const ref = value as ModelRef;
  if (!ref || (ref.backend !== 'claude' && ref.backend !== 'pi')) throw new Error('Invalid backend');
  if (typeof ref.model !== 'string' || !ref.model.trim()) throw new Error('Model must be a non-empty string');
  const validProvider = ref.backend === 'claude'
    ? ref.provider === null
    : typeof ref.provider === 'string' && SAFE_NAME.test(ref.provider);
  if (!validProvider) throw new Error('Invalid provider: PI requires a provider; Claude requires null');
}

export function validateEngineSelection(value: unknown): asserts value is EngineSelection {
  validateModelRef(value);
  const selection = value as EngineSelection;
  if (selection.thinking !== null && !isValidThinkingLevel(selection.backend, selection.thinking)) {
    throw new Error(`Invalid thinking for backend '${selection.backend}'`);
  }
  if (typeof selection.mode !== 'string' || !SAFE_NAME.test(selection.mode)) throw new Error('Invalid mode');
}

/** Copy only the public selection fields, never retired or foreign configuration. */
export function copySelection(selection: EngineSelection): EngineSelection {
  const { backend, provider, model, thinking, mode } = selection;
  return { backend, provider, model, thinking, mode };
}
