import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from './atomic-write.js';
import { CONFIG_DIR } from './paths.js';
import type { DiscoveredEndpoint } from './gateway-generator.js';
import type { EngineSelection, ModelRef, ModelsFile } from '../domain/agents/engine-selection.js';
import { createLogger } from './log.js';

const log = createLogger('models-generator');

export interface ModelChoice { mode: string; model: string }
export interface GenerateOpts { defaultChoice?: ModelChoice; favorites?: ModelChoice[] }
export interface WriteModelsOpts extends GenerateOpts { outputDir?: string; overwrite?: boolean }
interface ModelEntry extends ModelChoice { backend: EngineSelection['backend']; endpoint: string }

export function resolveBackend(endpoint: string, mode: string): EngineSelection['backend'] {
  return endpoint === 'anthropic' && (mode === 'plan' || mode === 'api') ? 'claude' : 'pi';
}

export function flattenModels(endpoints: DiscoveredEndpoint[]): ModelEntry[] {
  return endpoints.flatMap(ep => ep.models.map(model => ({
    model, backend: resolveBackend(ep.endpoint, ep.mode), mode: ep.mode, endpoint: ep.endpoint,
  })));
}

export function listChoices(endpoints: DiscoveredEndpoint[]): ModelChoice[] {
  return flattenModels(endpoints)
    .sort((a, b) => a.mode.localeCompare(b.mode) || a.model.localeCompare(b.model))
    .map(({ mode, model }) => ({ mode, model }));
}

/** Discovery order expresses preference; display sorting must not change the recommendation. */
export function recommendedChoice(endpoints: DiscoveredEndpoint[]): ModelChoice | undefined {
  const endpoint = endpoints.find(ep => ep.models.length > 0);
  if (!endpoint) return undefined;
  const model = endpoint.defaultModel && endpoint.models.includes(endpoint.defaultModel)
    ? endpoint.defaultModel : endpoint.models[0];
  return { mode: endpoint.mode, model };
}

function selectionForChoice(models: ModelEntry[], choice: ModelChoice): EngineSelection {
  const entry = models.find(m => m.mode === choice.mode && m.model === choice.model);
  if (!entry) throw new Error(`(mode="${choice.mode}", model="${choice.model}") not found among discovered models`);
  return {
    backend: entry.backend, provider: entry.backend === 'pi' ? entry.endpoint : null,
    model: entry.model, thinking: null, mode: entry.backend === 'pi' ? entry.endpoint : entry.mode,
  };
}

/** Keep only model identity in favorites, deduplicating independently of route and thinking. */
function unionFavorites(refs: ModelRef[]): ModelRef[] {
  const entries = refs.map(({ backend, provider, model }) => {
    const ref = { backend, provider, model };
    return [JSON.stringify([backend, provider, model]), ref] as const;
  });
  return [...new Map(entries).values()];
}

export function generateModels(endpoints: DiscoveredEndpoint[], opts: GenerateOpts = {}): ModelsFile {
  const choice = opts.defaultChoice ?? recommendedChoice(endpoints);
  if (!choice) throw new Error('No discovered model is available for the default selection');
  const models = flattenModels(endpoints);
  const selection = selectionForChoice(models, choice);
  const favorites = (opts.favorites ?? []).map(item => selectionForChoice(models, item));
  return { default: selection, favorites: unionFavorites([selection, ...favorites]) };
}

export function readExistingModels(configDir: string): Partial<ModelsFile> | null {
  const file = path.join(configDir, 'models.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelsFile>;
  } catch (error) {
    log.warn(`Failed to read models.json: ${(error as Error).message}`);
    return null;
  }
}

/** Preserve the operator's default unless explicitly overwritten; favorites are always a union. */
export function mergeModelsJson(generated: ModelsFile, outputDir = CONFIG_DIR, overwrite = false): ModelsFile {
  const existing = readExistingModels(outputDir);
  return {
    default: !overwrite && existing?.default ? existing.default : generated.default,
    favorites: unionFavorites([...(existing?.favorites ?? []), ...generated.favorites]),
  };
}

export function writeModelsJson(endpoints: DiscoveredEndpoint[], opts: WriteModelsOpts = {}): string {
  const configDir = opts.outputDir ?? CONFIG_DIR;
  const merged = mergeModelsJson(generateModels(endpoints, opts), configDir, opts.overwrite);
  const outputPath = path.join(configDir, 'models.json');
  atomicWriteSync(outputPath, JSON.stringify(merged, null, 2) + '\n');
  log.info(`Written models.json to ${outputPath}`);
  return outputPath;
}
