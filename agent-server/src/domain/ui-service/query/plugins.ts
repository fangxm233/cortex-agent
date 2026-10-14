import { ENVIRONMENTS_DIR, listEnvironmentNames, readEnvironment } from '@domain/agents/environments/index.js';
import {
  environmentPlugins,
  readPluginCatalogSnapshot,
  sanitizePluginEntry,
} from '../plugins-shared.js';
import type {
  PluginAgentTarget,
  PluginsListReturn,
  UiServiceDeps,
  QueryParams,
} from '../types.js';

function readAgentTargets(
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): PluginAgentTarget[] {
  const out: PluginAgentTarget[] = [];
  // Agent targets are the execution environments.
  for (const name of listEnvironmentNames(ENVIRONMENTS_DIR)) {
    const entity = readEnvironment(ENVIRONMENTS_DIR, name);
    if (!entity.body) continue;
    const normalized = environmentPlugins(entity.body, snapshot);
    out.push({
      kind: 'agent',
      name,
      editable: true,
      baseHash: entity.sha256,
      managedPluginIds: normalized.managedIds,
      unmanagedPluginCount: normalized.unmanaged.length,
    });
  }
  return out;
}

export async function handlePluginsList(
  _deps: UiServiceDeps,
  _params: QueryParams<'plugins.list'>,
): Promise<PluginsListReturn> {
  const snapshot = readPluginCatalogSnapshot();
  return {
    plugins: snapshot.entries.map((entry) => sanitizePluginEntry(entry)),
    targets: readAgentTargets(snapshot),
  };
}
