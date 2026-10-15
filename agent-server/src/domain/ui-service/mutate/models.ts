import path from 'node:path';
import fs from 'node:fs/promises';
import { CONFIG_DIR } from '@core/paths.js';
import { atomicWrite } from '@core/atomic-write.js';
import { readGatewayYaml } from '@core/gateway-generator.js';
import {
  modelKey, validateModelRef, validateEngineSelection,
  type EngineSelection, type ModelRef, type ModelsFile,
} from '@domain/agents/engine-selection.js';
import { GATEWAY_CONFIG_PATH } from '@domain/pi-providers/gateway-route-store.js';
import { modelsRepo, modelsWriteLock } from '@store/models-repo.js';
import { rememberModelSelection } from '@domain/agents/config.js';
import { modelsFavoriteInput, modelsSetDefaultInput } from '../input-schemas.js';
import type { UiServiceDeps, Result, ModelsMutationReturn, MutateArgs } from '../types.js';

type RawModelsFile = ModelsFile & Record<string, unknown>;
type GatewayReader = () => ReturnType<typeof readGatewayYaml>;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid-args' });
}

function validate<T>(fn: () => T): T {
  try { return fn(); }
  catch (error) { throw invalid(error instanceof Error ? error.message : String(error)); }
}

async function readModelsFile(configDir: string, initial?: EngineSelection): Promise<RawModelsFile> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(configDir, 'models.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.favorites)) {
      throw invalid('models.json must contain a default selection and favorites array');
    }
    validate(() => validateEngineSelection(raw.default ?? initial));
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && initial) return { default: initial, favorites: [] };
    throw invalid(`Cannot read models.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeModelsFile(configDir: string, next: RawModelsFile): Promise<void> {
  await atomicWrite(path.join(configDir, 'models.json'), JSON.stringify(next, null, 2) + '\n');
  // The next run must see the write before the file watcher's debounce expires.
  modelsRepo.invalidate();
}

function favorite(args: MutateArgs<'models.favorites.add'>): ModelRef {
  return validate(() => {
    const parsed = modelsFavoriteInput.parse(args);
    const ref = { backend: parsed.backend, provider: parsed.provider ?? null, model: parsed.model };
    validateModelRef(ref);
    return ref;
  });
}

export async function addFavorite(configDir: string, args: MutateArgs<'models.favorites.add'>): Promise<boolean> {
  const ref = favorite(args);
  return modelsWriteLock.run(async () => {
    const raw = await readModelsFile(configDir);
    if (raw.favorites.some((entry) => modelKey(entry) === modelKey(ref))) return false;
    await writeModelsFile(configDir, { ...raw, favorites: [...raw.favorites, ref] });
    return true;
  });
}

export async function removeFavorite(configDir: string, args: MutateArgs<'models.favorites.remove'>): Promise<boolean> {
  const ref = favorite(args);
  return modelsWriteLock.run(async () => {
    const raw = await readModelsFile(configDir);
    const favorites = raw.favorites.filter((entry) => modelKey(entry) !== modelKey(ref));
    if (favorites.length === raw.favorites.length) return false;
    await writeModelsFile(configDir, { ...raw, favorites });
    return true;
  });
}

function validateDefault(selection: EngineSelection, readGateway: GatewayReader): void {
  validateEngineSelection(selection);
  const endpoint = selection.backend === 'claude' ? 'anthropic' : selection.provider;
  const gateway = readGateway();
  const modes = Object.keys(gateway?.endpoints?.[endpoint] ?? {});
  if (gateway && !modes.includes(selection.mode)) throw invalid(`Unknown mode '${selection.mode}' for ${endpoint}`);
  if (selection.backend === 'pi' && selection.mode !== selection.provider) throw invalid('PI mode must equal provider');
}

export async function setDefaultModel(
  configDir: string,
  args: MutateArgs<'models.setDefault'>,
  readGateway: GatewayReader = () => readGatewayYaml(GATEWAY_CONFIG_PATH),
): Promise<boolean> {
  const { selection } = validate(() => modelsSetDefaultInput.parse(args));
  validate(() => validateDefault(selection, readGateway));
  return modelsWriteLock.run(async () => {
    const file = path.join(configDir, 'models.json');
    const exists = await fs.stat(file).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const raw = await readModelsFile(configDir, selection);
    if (exists && raw.default && modelKey(raw.default) === modelKey(selection)
      && raw.default.thinking === selection.thinking && raw.default.mode === selection.mode) return false;
    await writeModelsFile(configDir, { ...raw, default: selection });
    rememberModelSelection(selection);
    return true;
  });
}

async function mutation(write: () => Promise<boolean>): Promise<Result<ModelsMutationReturn>> {
  try { return { ok: true, data: { changed: await write() } }; }
  catch (error) {
    return {
      ok: false,
      code: (error as { code?: string }).code === 'invalid-args' ? 'invalid-args' : 'internal',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleModelsFavoriteAdd(
  _deps: UiServiceDeps, args: MutateArgs<'models.favorites.add'>,
): Promise<Result<ModelsMutationReturn>> {
  return mutation(() => addFavorite(CONFIG_DIR, args));
}

export async function handleModelsFavoriteRemove(
  _deps: UiServiceDeps, args: MutateArgs<'models.favorites.remove'>,
): Promise<Result<ModelsMutationReturn>> {
  return mutation(() => removeFavorite(CONFIG_DIR, args));
}

export async function handleModelsSetDefault(
  _deps: UiServiceDeps, args: MutateArgs<'models.setDefault'>,
): Promise<Result<ModelsMutationReturn>> {
  return mutation(() => setDefaultModel(CONFIG_DIR, args));
}
