import { t } from '@core/i18n.js';
import { ENVIRONMENTS_DIR, readEnvironment } from '@domain/agents/environments/index.js';
import { saveEnvironmentBody } from './environments.js';
import {
  addedInvalidPluginIds,
  addedMcpPluginIds,
  canonicalManagedPluginDirs,
  normalizePluginDirs,
  normalizedDesiredPluginIds,
  readPluginCatalogSnapshot,
} from '../plugins-shared.js';
import { fail, toErr } from './errors.js';
import type {
  PluginsAssignReturn,
  Result,
  UiServiceDeps,
  MutateArgs,
} from '../types.js';

function requireDesiredPluginIds(
  currentIds: readonly string[],
  pluginIds: readonly string[],
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): string[] {
  const desired = normalizedDesiredPluginIds(pluginIds);
  const invalid = addedInvalidPluginIds(currentIds, desired, snapshot);
  if (invalid.length > 0) throw fail('invalid-args', t('ui.plugin.unassignable', { ids: invalid.join(', ') }));
  return desired;
}

function requireMcpAck(
  currentIds: readonly string[],
  desiredIds: readonly string[],
  acknowledgeMcp: boolean | undefined,
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): void {
  const added = addedMcpPluginIds(currentIds, desiredIds, snapshot);
  if (added.length > 0 && acknowledgeMcp !== true) {
    throw fail('invalid-args', `Adding MCP-bearing plugins requires acknowledgeMcp: true (${added.join(', ')})`);
  }
}

function assignAgentPlugins(args: MutateArgs<'plugins.assign'>): PluginsAssignReturn {
  const snapshot = readPluginCatalogSnapshot();
  const entity = readEnvironment(ENVIRONMENTS_DIR, args.target.name);
  if (!entity.body) throw fail('invalid-args', `Agent '${args.target.name}' is not a JSON object`);
  const current = normalizePluginDirs(entity.body.pluginDirs, snapshot);
  const desired = requireDesiredPluginIds(current.managedIds, args.pluginIds, snapshot);
  requireMcpAck(current.managedIds, desired, args.acknowledgeMcp, snapshot);
  const next = { ...entity.body };
  const pluginDirs = [...canonicalManagedPluginDirs(desired), ...current.unmanaged];
  if (pluginDirs.length > 0) next.pluginDirs = pluginDirs;
  else delete next.pluginDirs;
  const saved = saveEnvironmentBody(args.target.name, next, args.target.baseHash);
  return { changed: saved.changed, baseHash: saved.sha256 };
}

export async function handlePluginsAssign(
  _deps: UiServiceDeps,
  args: MutateArgs<'plugins.assign'>,
): Promise<Result<PluginsAssignReturn>> {
  try {
    return { ok: true, data: assignAgentPlugins(args) };
  } catch (error) {
    return toErr(error);
  }
}
