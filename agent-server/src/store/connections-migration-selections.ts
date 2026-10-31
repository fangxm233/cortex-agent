// Stored engine selections named their route by gateway mode; they now name a connection. Claude's
// `plan` is its subscription, every other Claude mode kept its name as a connection id, and a PI
// selection names none (its provider is its connection). Each converter mutates the parsed
// document it is given and returns how many selections it changed, so a re-run changes nothing.

import { connectionForLegacyMode, LEGACY_SUBSCRIPTION_MODE, SUBSCRIPTION_CONNECTION } from '@core/connections-file.js';
import { PI_ANTHROPIC_MODE } from './legacy-gateway.js';

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLegacy(value: unknown): value is Json {
  return isJson(value) && 'mode' in value && !('connection' in value);
}

/** Rename one selection-shaped object in place; true when it changed. */
export function convertSelection(value: unknown, backend: unknown = isJson(value) ? value.backend : undefined): boolean {
  if (!isLegacy(value)) return false;
  value.connection = connectionForLegacyMode(backend, value.mode);
  delete value.mode;
  return true;
}

function convertValues(map: unknown, convert: (key: string, value: unknown) => boolean): number {
  if (!isJson(map)) return 0;
  return Object.entries(map).filter(([key, value]) => convert(key, value)).length;
}

/** A model-memory key is `JSON.stringify([backend, provider, model])`. */
function memoryBackend(key: string): unknown {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

/** data/agent-state.json: per-channel selections, per-model memory and the new-session seed. */
export function convertAgentState(state: Json): number {
  return convertValues(state.channelSelections, (_key, value) => convertSelection(value))
    + convertValues(state.modelMemory, (key, value) => convertSelection(value, memoryBackend(key)))
    + Number(convertSelection(state.selectionDefault));
}

/** config/models.json: the default selection. */
export function convertModelsFile(models: Json): number {
  return Number(convertSelection(models.default));
}

/** data/schedules.json: each task's pinned selection. */
export function convertSchedules(schedules: Json): number {
  const tasks = Array.isArray(schedules.tasks) ? schedules.tasks : [];
  return tasks.filter((task) => isJson(task) && convertSelection(task.selection)).length;
}

/** data/pending-injections.json: queued turns carry the selection they will run with. */
export function convertPendingInjections(document: Json): number {
  return convertValues(document.records, (_key, record) => isJson(record) && convertSelection(record.selection));
}

/** Rate-limit throttle modes are now route names: the subscription by its connection, PI's
 *  `anthropic` provider by its provider. */
const THROTTLE_RENAMES: Record<string, string> = {
  [LEGACY_SUBSCRIPTION_MODE]: SUBSCRIPTION_CONNECTION,
  [PI_ANTHROPIC_MODE]: 'anthropic',
};

function renameModes(provider: unknown): boolean {
  if (!isJson(provider) || !Array.isArray(provider.modes)) return false;
  const modes = provider.modes as unknown[];
  if (!modes.some((mode) => typeof mode === 'string' && mode in THROTTLE_RENAMES)) return false;
  provider.modes = [...new Set(modes.map((mode) => (typeof mode === 'string' && THROTTLE_RENAMES[mode]) || mode))];
  return true;
}

/** data/provider-state.json: the persisted rate-limit throttle. */
export function convertProviderState(state: Json): number {
  const throttle = state.rateLimitThrottle;
  const providers = isJson(throttle) && Array.isArray(throttle.providers) ? throttle.providers : [];
  return providers.filter(renameModes).length;
}
