import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { pluginUsedBy } from './plugin-assign-vm';

export type PluginTab = 'overview' | 'skills' | 'mcp';

export const PLUGIN_TABS: readonly PluginTab[] = ['overview', 'skills', 'mcp'];

/** One environment a plugin is assigned to. */
export interface PluginUsage {
  key: string;
  name: string;
}

function matchesSearch(plugin: UiPluginCatalogEntry, needle: string): boolean {
  const haystack = [plugin.id, plugin.manifest.name ?? '', plugin.manifest.description ?? '']
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

export function filterPlugins(
  plugins: readonly UiPluginCatalogEntry[],
  search: string,
): UiPluginCatalogEntry[] {
  const needle = search.trim().toLowerCase();
  if (needle === '') return [...plugins];
  return plugins.filter((plugin) => matchesSearch(plugin, needle));
}

/** The requested plugin if it still exists, else the first of the visible list. Keeps the detail
 *  pane populated when a filter change drops the previous selection. */
export function resolvePluginSelection(
  visible: readonly UiPluginCatalogEntry[],
  requestedId: string | null,
): UiPluginCatalogEntry | null {
  if (requestedId) {
    const found = visible.find((plugin) => plugin.id === requestedId);
    if (found) return found;
  }
  return visible[0] ?? null;
}

export function pluginUsage(
  targets: readonly PluginAssignmentTarget[],
  pluginId: string,
): PluginUsage[] {
  return pluginUsedBy(targets, pluginId).map((target) => ({ key: `agent:${target.name}`, name: target.name }));
}
