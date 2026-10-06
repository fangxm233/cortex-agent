import type {
  PluginAssignmentTarget,
  UiPluginCatalogEntry,
  MutateArgs,
} from '@cortex-agent/ui-contract';

/** The environment whose assignment is being edited. Assignment is a field of the environment, so
 *  the scope is always one config file — never the plugin. */
export interface PluginAssignScope {
  name: string;
}

export interface PluginsPanelDraft {
  targetKey: string;
  baseHash: string;
  sourceFingerprint: string;
  pluginIds: string[];
}

export interface PluginDraftState {
  dirty: boolean;
  conflicted: boolean;
  canSave: boolean;
  canReset: boolean;
}

export type PluginToggleDisabledReason = 'readonly' | 'invalid' | null;

function dedupePluginIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isSelected(draft: PluginsPanelDraft, pluginId: string): boolean {
  return draft.pluginIds.includes(pluginId);
}

export function pluginTargetKey(target: PluginAssignmentTarget): string {
  return `agent:${target.name}`;
}

export function resolvePluginTarget(targets: readonly PluginAssignmentTarget[], key: string | null): PluginAssignmentTarget | null {
  if (!key) return targets[0] ?? null;
  return targets.find((target) => pluginTargetKey(target) === key) ?? targets[0] ?? null;
}

function draftSourceFingerprint(pluginIds: readonly string[]): string {
  return JSON.stringify(dedupePluginIds(pluginIds));
}

export function createPluginDraft(target: PluginAssignmentTarget): PluginsPanelDraft {
  const pluginIds = dedupePluginIds(target.managedPluginIds);
  return {
    targetKey: pluginTargetKey(target), baseHash: target.baseHash,
    sourceFingerprint: draftSourceFingerprint(pluginIds), pluginIds,
  };
}

function hasDraftChanges(draft: PluginsPanelDraft): boolean {
  return draftSourceFingerprint(draft.pluginIds) !== draft.sourceFingerprint;
}

/** Follow the live target unless the draft holds unsaved choices: a dirty draft survives a hash
 *  change so it can be shown as conflicted rather than silently dropped. */
export function syncPluginDraft(target: PluginAssignmentTarget, draft: PluginsPanelDraft | null): PluginsPanelDraft {
  const fresh = createPluginDraft(target);
  if (!draft || draft.targetKey !== fresh.targetKey) return fresh;
  if (draft.baseHash !== fresh.baseHash) return hasDraftChanges(draft) ? draft : fresh;
  return draft.sourceFingerprint === fresh.sourceFingerprint ? draft : fresh;
}

export function pluginToggleDisabledReason(
  target: PluginAssignmentTarget | null,
  draft: PluginsPanelDraft | null,
  plugin: UiPluginCatalogEntry,
): PluginToggleDisabledReason {
  if (!target || !draft) return 'readonly';
  if (isSelected(draft, plugin.id)) return null;
  return plugin.assignable ? null : 'invalid';
}

export function togglePluginDraftId(
  draft: PluginsPanelDraft,
  target: PluginAssignmentTarget,
  plugin: UiPluginCatalogEntry,
): PluginsPanelDraft {
  if (pluginToggleDisabledReason(target, draft, plugin)) return draft;
  const next = isSelected(draft, plugin.id)
    ? draft.pluginIds.filter((id) => id !== plugin.id)
    : [...draft.pluginIds, plugin.id];
  return { ...draft, pluginIds: dedupePluginIds(next) };
}

export function pluginDraftState(
  target: PluginAssignmentTarget | null,
  draft: PluginsPanelDraft | null,
  pending: boolean,
): PluginDraftState {
  if (!target || !draft) {
    return { dirty: false, conflicted: false, canSave: false, canReset: false };
  }
  const conflicted = target.baseHash !== draft.baseHash;
  const dirty = conflicted || hasDraftChanges(draft);
  return { dirty, conflicted, canSave: dirty && !conflicted && !pending, canReset: dirty && !pending };
}

export function draftMcpPlugins(
  target: PluginAssignmentTarget | null,
  draft: PluginsPanelDraft | null,
  plugins: readonly UiPluginCatalogEntry[],
): UiPluginCatalogEntry[] {
  if (!target || !draft) return [];
  const current = new Set(dedupePluginIds(target.managedPluginIds));
  const desired = new Set(dedupePluginIds(draft.pluginIds));
  return plugins.filter((plugin) => desired.has(plugin.id) && !current.has(plugin.id) && plugin.mcp.servers.length > 0);
}

export function buildPluginsAssignArgs(
  target: PluginAssignmentTarget | null,
  draft: PluginsPanelDraft | null,
): MutateArgs<'plugins.assign'> | null {
  if (!target || !draft) return null;
  return {
    target: { kind: 'agent', name: target.name, baseHash: draft.baseHash },
    pluginIds: dedupePluginIds(draft.pluginIds),
  };
}

/** The assignment target of one environment (at most one). */
export function scopedAssignTargets(
  targets: readonly PluginAssignmentTarget[],
  scope: PluginAssignScope,
): PluginAssignmentTarget[] {
  return targets.filter((target) => target.name === scope.name);
}

/** Environments that currently reference `pluginId` — the reverse of assignment, read straight off
 *  the targets `plugins.list` already returns. */
export function pluginUsedBy(
  targets: readonly PluginAssignmentTarget[],
  pluginId: string,
): PluginAssignmentTarget[] {
  return targets.filter((target) => target.managedPluginIds.includes(pluginId));
}
