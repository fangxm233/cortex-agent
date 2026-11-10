import path from 'node:path';
import fs from 'node:fs/promises';
import { CONFIG_DIR } from '@core/paths.js';
import { atomicWrite } from '@core/atomic-write.js';
import { withLegacyConnection } from '@core/connections-file.js';
import {
  modelKey, validateModelRef, validateEngineSelection,
  type EngineSelection, type ModelRef, type ModelsFile,
} from '@domain/agents/engine-selection.js';
import type { CredentialInventory } from '@domain/connections/inventory.js';
import type { CatalogSnapshot } from '@domain/models/catalog.js';
import { modelsRepo, modelsWriteLock } from '@store/models-repo.js';
import { resolveDaemonSelection } from '@domain/agents/model-selection.js';
import { resolveSelection } from '@domain/agents/resolve-selection.js';
import { getModelMemory, rememberModelSelection } from '@domain/agents/config.js';
import {
  modelsFavoriteInput, modelsSetDefaultInput, modelsSetDelegationInput, modelsSetThinkingInput,
} from '../input-schemas.js';
import { parseDelegationPolicy, type DelegationPolicy } from '@core/agents/subagent/delegation-policy.js';
import type { UiServiceDeps, Result, ModelsMutationReturn, MutateArgs } from '../types.js';

type RawModelsFile = ModelsFile & Record<string, unknown>;

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
    if (raw.default) raw.default = withLegacyConnection(raw.default);
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

/** What a settings write is checked against; the daemon's own by default. */
export interface ModelsMutationContext {
  inventory?: CredentialInventory;
  catalog?: () => CatalogSnapshot;
}

function resolutionError(reason: string, allowed?: readonly string[]): Error {
  return invalid(allowed?.length ? `${reason} (allowed: ${allowed.join(', ')})` : reason);
}

/** The new default, completed and checked like any other pick against the file's current default:
 *  a thinking level the model does not accept, or a newly named connection that does not exist, is
 *  refused. */
function resolveDefault(
  selection: EngineSelection, current: EngineSelection | null, context: ModelsMutationContext,
): EngineSelection {
  const resolution = resolveSelection({
    ...context,
    request: current,
    defaults: { selection: () => current, forBackend: () => null },
    memory: getModelMemory,
  }, selection);
  if (resolution.ok === false) throw resolutionError(resolution.reason, resolution.allowed);
  return resolution.selection;
}

function sameDefault(current: EngineSelection | undefined, next: EngineSelection): boolean {
  return !!current && modelKey(current) === modelKey(next)
    && current.thinking === next.thinking && current.connection === next.connection;
}

export async function setDefaultModel(
  configDir: string,
  args: MutateArgs<'models.setDefault'>,
  context: ModelsMutationContext = {},
): Promise<boolean> {
  const parsed = validate(() => modelsSetDefaultInput.parse(args)).selection;
  validate(() => validateEngineSelection(parsed));
  return modelsWriteLock.run(async () => {
    const file = path.join(configDir, 'models.json');
    const exists = await fs.stat(file).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const raw = await readModelsFile(configDir, parsed);
    const selection = resolveDefault(parsed, exists ? raw.default ?? null : null, context);
    if (exists && sameDefault(raw.default, selection)) return false;
    await writeModelsFile(configDir, { ...raw, default: selection });
    rememberModelSelection(selection);
    return true;
  });
}

export async function setModelThinking(
  configDir: string,
  args: MutateArgs<'models.setThinking'>,
  context: ModelsMutationContext = {},
): Promise<boolean> {
  const { ref, thinking } = validate(() => modelsSetThinkingInput.parse(args));
  validate(() => validateModelRef(ref));
  return modelsWriteLock.run(async () => {
    const raw = await readModelsFile(configDir);
    if (!raw.favorites.some(entry => modelKey(entry) === modelKey(ref))) throw invalid('Model is not a favorite');
    const resolution = resolveDaemonSelection({ ...context, request: { ...ref, thinking: null, connection: null } }, { thinking });
    if (resolution.ok === false) throw resolutionError(resolution.reason, resolution.allowed);
    if (getModelMemory()[modelKey(ref)]?.thinking === thinking) return false;
    rememberModelSelection(resolution.selection);
    return true;
  });
}

function samePolicy(left: DelegationPolicy, right: DelegationPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Replace the delegation policy; patterns are kept as written, minus blanks and repeats. */
export async function setDelegation(configDir: string, args: MutateArgs<'models.setDelegation'>): Promise<boolean> {
  const parsed = validate(() => modelsSetDelegationInput.parse(args));
  const unique = (patterns: string[]) => [...new Set(patterns)];
  const next: DelegationPolicy = {
    allow: Array.isArray(parsed.allow) ? unique(parsed.allow) : parsed.allow,
    deny: unique(parsed.deny),
  };
  return modelsWriteLock.run(async () => {
    const raw = await readModelsFile(configDir);
    if (raw.delegation !== undefined && samePolicy(parseDelegationPolicy(raw.delegation), next)) return false;
    await writeModelsFile(configDir, { ...raw, delegation: next });
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

export async function handleModelsSetThinking(
  _deps: UiServiceDeps, args: MutateArgs<'models.setThinking'>,
): Promise<Result<ModelsMutationReturn>> {
  return mutation(() => setModelThinking(CONFIG_DIR, args));
}

export async function handleModelsSetDelegation(
  _deps: UiServiceDeps, args: MutateArgs<'models.setDelegation'>,
): Promise<Result<ModelsMutationReturn>> {
  return mutation(() => setDelegation(CONFIG_DIR, args));
}
