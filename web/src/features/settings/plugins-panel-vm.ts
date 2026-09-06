// input:  the sanitized plugin catalog and assignment targets
// output: plugin list filtering, selection, and usage grouping
// pos:    Pure view model for the plugin package manager
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { pluginUsedBy } from './plugin-assign-vm';

export type PluginTab = 'overview' | 'skills' | 'mcp';

export const PLUGIN_TABS: readonly PluginTab[] = ['overview', 'skills', 'mcp'];

/** One place a plugin is in use. Agents are named directly; template slots carry the slot position
 *  so an operator can find the row they need to edit. */
export interface PluginUsage {
  key: string;
  kind: 'agent' | 'template-slot';
  name: string;
  slot: string | null;
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
  return pluginUsedBy(targets, pluginId).map((target) => (
    target.kind === 'agent'
      ? { key: `agent:${target.name}`, kind: 'agent' as const, name: target.name, slot: null }
      : {
        key: `slot:${target.templateName}:${target.index}`,
        kind: 'template-slot' as const,
        name: target.templateName,
        slot: `[${target.index + 1}] ${target.ref}`,
      }
  ));
}
