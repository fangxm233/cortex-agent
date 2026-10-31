// Seeding models.json from the ModelCatalog. After a login, and during `cortex init`, every route
// the host can now reach that has no favorite yet gains its recommended model, and a host without
// a default gets the first one. The operator's own default and favorites are never replaced.

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ANTHROPIC_MODELS } from '@core/anthropic-models.js';
import { atomicWriteSync } from '@core/atomic-write.js';
import { createLogger } from '@core/log.js';
import { CONFIG_DIR } from '@core/paths.js';
import { loadPiDefaultModels } from '@core/pi-sdk.js';
import type { Backend } from '@core/types/agent-types.js';
import { modelsRepo, modelsWriteLock } from '@store/models-repo.js';
import type { EngineSelection, ModelRef, ModelsFile } from '../agents/engine-selection.js';
import { credentialInventory, type ConnectionView } from '../connections/inventory.js';
import { modelCatalog, type CatalogRoute, type CatalogSnapshot, type ModelCatalog } from './catalog.js';

const log = createLogger('model-seed');

/** PI's own default model per provider (from its SDK); empty when the table cannot be loaded. */
export type PiDefaultModels = Readonly<Record<string, string>>;

export interface ModelSeedResult {
  /** Whether the host could reach any route to seed from. */
  configured: boolean;
  /** How many routes were considered. */
  routes: number;
  /** Whether this seeding supplied a previously missing default. */
  defaultSet: boolean;
  /** Favorites present after the seeding. */
  favorites: ModelRef[];
  reason?: string;
}

export interface ModelSeedOptions {
  /** Only routes on these backends (the one just logged in); every backend when omitted. */
  backends?: readonly Backend[];
  configDir?: string;
  catalog?: ModelCatalog;
  connections?: () => ConnectionView[];
  piDefaults?: () => Promise<PiDefaultModels>;
}

interface Recommender {
  claude: ConnectionView[];
  piDefaults: PiDefaultModels;
}

/** Claude: the newest flagship when a connection serves the Anthropic catalog; otherwise the first
 *  model a connection lists itself (a local endpoint cannot run Anthropic's models). */
function claudeModel(route: CatalogRoute, claude: ConnectionView[]): string | undefined {
  if (claude.some((view) => view.models === null)) {
    return ANTHROPIC_MODELS.find((id) => route.models.includes(id)) ?? route.models[0];
  }
  return claude.flatMap((view) => view.models ?? [])[0] ?? route.models[0];
}

/** PI: the provider's own default when the scan lists it, else the first model the scan reported. */
function piModel(route: CatalogRoute, defaults: PiDefaultModels): string | undefined {
  const preferred = route.provider ? defaults[route.provider] : undefined;
  return preferred && route.models.includes(preferred) ? preferred : route.models[0];
}

function recommendedModel(route: CatalogRoute, recommender: Recommender): ModelRef | null {
  const model = route.backend === 'claude'
    ? claudeModel(route, recommender.claude) : piModel(route, recommender.piDefaults);
  return model ? { backend: route.backend, provider: route.provider, model } : null;
}

/** One recommendation per route, in catalog order (Claude first), on the given backends. */
export function recommendedModels(
  snapshot: CatalogSnapshot, recommender: Recommender, backends?: readonly Backend[],
): ModelRef[] {
  return snapshot.routes
    .filter((route) => !backends || backends.includes(route.backend))
    .map((route) => recommendedModel(route, recommender))
    .filter((ref): ref is ModelRef => ref !== null);
}

function routeKey(ref: Pick<ModelRef, 'backend' | 'provider'>): string {
  return JSON.stringify([ref.backend, ref.provider]);
}

function identity({ backend, provider, model }: ModelRef): ModelRef {
  return { backend, provider, model };
}

function uniqueRefs(refs: ModelRef[]): ModelRef[] {
  const entries = refs.map((ref) => [JSON.stringify([ref.backend, ref.provider, ref.model]), identity(ref)] as const);
  return [...new Map(entries).values()];
}

export interface ModelPicks {
  default?: EngineSelection;
  favorites?: ModelRef[];
}

/** Explicit picks on top of a file: a picked default replaces its default; picks join favorites. */
export function withPicks(file: ModelsFile, picks: ModelPicks): ModelsFile {
  const favorites = [...file.favorites, ...(picks.default ? [identity(picks.default)] : []), ...(picks.favorites ?? [])];
  return { default: picks.default ?? file.default, favorites: uniqueRefs(favorites) };
}

/** Add the recommendations whose route has no favorite yet; supply a default only when missing. */
export function mergeRecommendations(
  saved: Partial<ModelsFile> | null, recommended: ModelRef[],
): { file: ModelsFile; defaultSet: boolean } {
  const favorites = [...(saved?.favorites ?? [])];
  const routes = new Set(favorites.map(routeKey));
  for (const ref of recommended) {
    if (routes.has(routeKey(ref))) continue;
    favorites.push(ref);
    routes.add(routeKey(ref));
  }
  const fallback: EngineSelection = { ...identity(recommended[0]), thinking: null, connection: null };
  const file = { default: saved?.default ?? fallback, favorites: uniqueRefs(favorites) };
  return { file, defaultSet: !saved?.default };
}

/** models.json as written, or null when absent or unreadable. */
export function readModelsFile(configDir: string): Partial<ModelsFile> | null {
  const file = path.join(configDir, 'models.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelsFile>;
  } catch (error) {
    log.warn(`Failed to read models.json: ${(error as Error).message}`);
    return null;
  }
}

/** Replace models.json atomically and drop the daemon's cached copy. */
export function writeModelsFile(configDir: string, file: ModelsFile): string {
  const target = path.join(configDir, 'models.json');
  atomicWriteSync(target, JSON.stringify(file, null, 2) + '\n');
  modelsRepo.invalidate();
  return target;
}

type RecommendOptions = Pick<ModelSeedOptions, 'backends' | 'connections' | 'piDefaults'>;

/** The recommendations for a snapshot, read against the host's connections and PI's defaults. */
export async function recommendFor(snapshot: CatalogSnapshot, options: RecommendOptions = {}): Promise<ModelRef[]> {
  const claude = (options.connections ?? (() => credentialInventory.list()))().filter((view) => view.backend === 'claude');
  const piDefaults = await (options.piDefaults ?? (() => loadPiDefaultModels()))();
  return recommendedModels(snapshot, { claude, piDefaults }, options.backends);
}

async function seedFrom(snapshot: CatalogSnapshot, options: ModelSeedOptions): Promise<ModelSeedResult> {
  const recommended = await recommendFor(snapshot, options);
  if (recommended.length === 0) {
    return { configured: false, routes: 0, defaultSet: false, favorites: [], reason: 'no-routes' };
  }
  const configDir = options.configDir ?? CONFIG_DIR;
  const merged = await modelsWriteLock.run(async () => {
    const result = mergeRecommendations(readModelsFile(configDir), recommended);
    writeModelsFile(configDir, result.file);
    return result;
  });
  log.info(`Seeded models from ${recommended.length} route(s) → ${merged.file.favorites.length} favorite model(s)`);
  return { configured: true, routes: recommended.length, defaultSet: merged.defaultSet, favorites: merged.file.favorites };
}

/** Seed favorites and a missing default from what the host can reach now. Never throws: a login
 *  must not fail because its models could not be listed. */
export async function seedModelsFromCatalog(options: ModelSeedOptions = {}): Promise<ModelSeedResult> {
  try {
    return await seedFrom(await (options.catalog ?? modelCatalog).reload(), options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`Model seeding skipped: ${reason}`);
    return { configured: false, routes: 0, defaultSet: false, favorites: [], reason };
  }
}
