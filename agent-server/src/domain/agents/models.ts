import type { Backend } from '@core/types/agent-types.js';
import { readGatewayYaml } from '@core/gateway-generator.js';
import { modelsRepo } from '@store/models-repo.js';
import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import { GATEWAY_CONFIG_PATH } from '../pi-providers/gateway-route-store.js';
import { getModelMemory } from './config.js';
import {
  copySelection, modelKey, validateEngineSelection, validateModelRef,
  type EngineSelection, type ModelRef, type ModelsFile,
} from './engine-selection.js';

let validated: ModelsFile | null = null;

export function validateModelsFile(value: unknown): asserts value is ModelsFile {
  const data = value as ModelsFile;
  validateEngineSelection(data?.default);
  if (!Array.isArray(data.favorites)) throw new Error('favorites must be an array');
  const seen = new Set<string>();
  for (const ref of data.favorites) {
    validateModelRef(ref);
    const key = modelKey(ref);
    if (seen.has(key)) throw new Error(`Duplicate favorite: ${ref.model}`);
    seen.add(key);
  }
}

export function loadModelsFile(): ModelsFile {
  try {
    const data = modelsRepo.readSync();
    if (data !== validated) { validateModelsFile(data); validated = data; }
    return { default: copySelection(data.default), favorites: data.favorites.map(copyRef) };
  } catch (error) {
    throw new Error(`Failed to load models.json: ${(error as Error).message}`);
  }
}

function copyRef({ backend, provider, model }: ModelRef): ModelRef {
  return { backend, provider, model };
}

export function getDefaultSelection(): EngineSelection { return loadModelsFile().default; }
export function listFavorites(): ModelRef[] { return loadModelsFile().favorites; }

export function getDefaultSelectionForBackend(backend: Backend): EngineSelection | null {
  let file: ModelsFile;
  try { file = loadModelsFile(); } catch { return null; }
  if (file.default.backend === backend) return file.default;
  const favorite = file.favorites.find((ref) => ref.backend === backend);
  return favorite ? selectionForModel(favorite) : null;
}

export function selectionForModel(ref: ModelRef): EngineSelection {
  validateModelRef(ref);
  const memory = getModelMemory()[modelKey(ref)];
  return { ...copyRef(ref), ...(memory ?? { thinking: null, mode: firstModelRoute(ref) }) };
}

/** PI's generated route is its provider. Claude uses gateway declaration order. */
export function firstModelRoute(
  ref: ModelRef,
  readGateway = () => readGatewayYaml(GATEWAY_CONFIG_PATH),
): string {
  if (ref.backend === 'pi') return ref.provider!;
  const modes = readGateway()?.endpoints?.anthropic;
  return Object.keys(modes ?? {})[0] ?? 'plan';
}

function explicitRef(ref: string): ModelRef | null {
  const slash = ref.indexOf('/');
  if (slash < 0) return null;
  const result: ModelRef = { backend: 'pi', provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
  validateModelRef(result);
  return result;
}

function resolvePiRef(model: string, file: ModelsFile): ModelRef {
  const candidates = [file.default, ...file.favorites,
    ...piProviderDiscovery.peekModels().map((pair) => ({ ...pair, backend: 'pi' as const }))];
  const match = candidates.find((ref) => ref.backend === 'pi' && ref.model === model);
  if (match) return copyRef(match);
  if (file.default.backend === 'pi') return { backend: 'pi', provider: file.default.provider, model };
  throw new Error(`Unknown PI model '${model}': specify provider/model or favorite a model first`);
}

/** Synchronous: use warm catalog entries, never start a provider scan to parse a command. */
export function resolveModelRef(ref: string, backend?: Backend): ModelRef {
  const model = ref.trim();
  if (!model) throw new Error('Model must be a non-empty string');
  const explicit = explicitRef(model);
  if (explicit) return explicit;
  const file = loadModelsFile();
  const target = backend ?? file.default.backend;
  return target === 'claude' ? { backend: 'claude', provider: null, model } : resolvePiRef(model, file);
}
