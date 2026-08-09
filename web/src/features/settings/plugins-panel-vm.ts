// input:  plugin DTOs, selected targets, local drafts
// output: plugin draft sync, gating, and payload helpers
// pos:    Pure plugin assignment view model
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type {
  PluginAgentTarget,
  PluginAssignmentTarget,
  PluginTemplateSlotTarget,
  PluginsAssignArgs,
  UiPluginCatalogEntry,
} from '@cortex-agent/ui-contract';

export interface PluginsPanelDraft {
  targetKey: string;
  mode: PluginTemplateSlotTarget['mode'] | null;
  baseHash: string;
  sourceFingerprint: string;
  pluginIds: string[];
}

export interface PluginDraftState {
  dirty: boolean;
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

function agentForRef(targets: readonly PluginAssignmentTarget[], ref: string): PluginAgentTarget | null {
  return targets.find((target): target is PluginAgentTarget => target.kind === 'agent' && target.name === ref) ?? null;
}

function inheritedPluginIds(target: PluginTemplateSlotTarget, targets: readonly PluginAssignmentTarget[]): string[] {
  return dedupePluginIds(agentForRef(targets, target.ref)?.managedPluginIds ?? target.managedPluginIds);
}

function templateMode(target: PluginAssignmentTarget): PluginTemplateSlotTarget['mode'] | null {
  return target.kind === 'template-slot' ? target.mode : null;
}

function targetPluginIds(target: PluginAssignmentTarget): string[] {
  if (target.kind === 'template-shell') return [];
  return dedupePluginIds(target.managedPluginIds);
}

function isEditableTarget(target: PluginAssignmentTarget | null): target is PluginAgentTarget | PluginTemplateSlotTarget {
  return !!target?.editable;
}

function isSelected(draft: PluginsPanelDraft, pluginId: string): boolean {
  return draft.pluginIds.includes(pluginId);
}

function isInheritedDraft(target: PluginAssignmentTarget | null, draft: PluginsPanelDraft | null): boolean {
  return target?.kind === 'template-slot' && draft?.mode === 'inherit';
}

export function pluginTargetKey(target: PluginAssignmentTarget): string {
  if (target.kind === 'agent') return `agent:${target.name}`;
  if (target.kind === 'template-shell') return `template-shell:${target.templateName}`;
  return `template-slot:${target.templateName}:${target.index}:${target.ref}`;
}

export function resolvePluginTarget(targets: readonly PluginAssignmentTarget[], key: string | null): PluginAssignmentTarget | null {
  if (!key) return targets[0] ?? null;
  return targets.find((target) => pluginTargetKey(target) === key) ?? targets[0] ?? null;
}

export function resolvePluginTargetKey(targets: readonly PluginAssignmentTarget[], key: string | null): string | null {
  const target = resolvePluginTarget(targets, key);
  return target ? pluginTargetKey(target) : null;
}

function draftSourceFingerprint(
  mode: PluginTemplateSlotTarget['mode'] | null,
  pluginIds: readonly string[],
): string {
  return JSON.stringify({ mode, pluginIds: dedupePluginIds(pluginIds) });
}

export function createPluginDraft(target: PluginAssignmentTarget, targets: readonly PluginAssignmentTarget[]): PluginsPanelDraft {
  const pluginIds = target.kind === 'template-slot' && target.mode === 'inherit'
    ? inheritedPluginIds(target, targets)
    : targetPluginIds(target);
  const mode = templateMode(target);
  return {
    targetKey: pluginTargetKey(target), mode, baseHash: target.baseHash,
    sourceFingerprint: draftSourceFingerprint(mode, pluginIds), pluginIds,
  };
}

function syncPersistedInherit(
  draft: PluginsPanelDraft,
  fresh: PluginsPanelDraft,
): PluginsPanelDraft {
  return draft.sourceFingerprint === fresh.sourceFingerprint ? draft : fresh;
}

function syncCustomToInherit(
  target: PluginTemplateSlotTarget,
  targets: readonly PluginAssignmentTarget[],
  draft: PluginsPanelDraft,
): PluginsPanelDraft {
  const pluginIds = inheritedPluginIds(target, targets);
  const unchanged = JSON.stringify(dedupePluginIds(draft.pluginIds)) === JSON.stringify(pluginIds);
  return unchanged ? draft : { ...draft, pluginIds };
}

function preservesCustomOverride(
  target: PluginAssignmentTarget,
  draft: PluginsPanelDraft,
): boolean {
  return target.kind === 'template-slot'
    && target.mode === 'inherit'
    && draft.mode === 'custom';
}

function syncInheritedDraft(
  target: PluginAssignmentTarget,
  targets: readonly PluginAssignmentTarget[],
  draft: PluginsPanelDraft,
  fresh: PluginsPanelDraft,
): PluginsPanelDraft | null {
  if (preservesCustomOverride(target, draft)) return draft;
  if (target.kind !== 'template-slot' || draft.mode !== 'inherit') return null;
  return target.mode === 'inherit'
    ? syncPersistedInherit(draft, fresh)
    : syncCustomToInherit(target, targets, draft);
}

function syncSourceDraft(
  draft: PluginsPanelDraft,
  fresh: PluginsPanelDraft,
): PluginsPanelDraft {
  return draft.sourceFingerprint === fresh.sourceFingerprint ? draft : fresh;
}

export function syncPluginDraft(
  target: PluginAssignmentTarget,
  targets: readonly PluginAssignmentTarget[],
  draft: PluginsPanelDraft | null,
): PluginsPanelDraft {
  const fresh = createPluginDraft(target, targets);
  if (!draft || draft.targetKey !== fresh.targetKey) return fresh;
  if (draft.baseHash !== fresh.baseHash) return fresh;
  const inherited = syncInheritedDraft(target, targets, draft, fresh);
  return inherited ?? syncSourceDraft(draft, fresh);
}

export function setPluginDraftMode(
  draft: PluginsPanelDraft,
  target: PluginAssignmentTarget,
  targets: readonly PluginAssignmentTarget[],
  mode: PluginTemplateSlotTarget['mode'],
): PluginsPanelDraft {
  if (target.kind !== 'template-slot' || !target.editable || mode === draft.mode) return draft;
  const pluginIds = mode === 'inherit' ? inheritedPluginIds(target, targets) : dedupePluginIds(draft.pluginIds);
  return { ...draft, mode, pluginIds };
}

export function pluginToggleDisabledReason(
  target: PluginAssignmentTarget | null,
  draft: PluginsPanelDraft | null,
  plugin: UiPluginCatalogEntry,
): PluginToggleDisabledReason {
  if (!isEditableTarget(target) || !draft || isInheritedDraft(target, draft)) return 'readonly';
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
  if (!target || !draft || !isEditableTarget(target)) return { dirty: false, canSave: false, canReset: false };
  const current = draftSourceFingerprint(draft.mode, draft.pluginIds);
  const dirty = current !== draft.sourceFingerprint;
  return { dirty, canSave: dirty && !pending, canReset: dirty && !pending };
}

export function targetReadOnlyReason(target: PluginAssignmentTarget | null): 'active-agent' | 'shell-binding' | null {
  if (!target || target.editable) return null;
  return target.readOnlyReason ?? null;
}

function slotUnmanagedPluginCount(
  target: PluginTemplateSlotTarget,
  targets: readonly PluginAssignmentTarget[],
  mode: PluginTemplateSlotTarget['mode'] | null,
): number {
  if (mode === 'custom' && target.mode === 'custom') return target.unmanagedPluginCount;
  return agentForRef(targets, target.ref)?.unmanagedPluginCount ?? target.unmanagedPluginCount;
}

export function effectiveUnmanagedPluginCount(
  target: PluginAssignmentTarget | null,
  targets: readonly PluginAssignmentTarget[],
  mode: PluginTemplateSlotTarget['mode'] | null,
): number {
  if (!target || target.kind === 'template-shell') return 0;
  if (target.kind === 'agent') return target.unmanagedPluginCount;
  return slotUnmanagedPluginCount(target, targets, mode);
}

export function draftMcpPlugins(
  target: PluginAssignmentTarget | null,
  draft: PluginsPanelDraft | null,
  plugins: readonly UiPluginCatalogEntry[],
): UiPluginCatalogEntry[] {
  if (!target || !draft) return [];
  const current = new Set(targetPluginIds(target));
  const desired = new Set(dedupePluginIds(draft.pluginIds));
  return plugins.filter((plugin) => desired.has(plugin.id) && !current.has(plugin.id) && plugin.mcp.servers.length > 0);
}

export function buildPluginsAssignArgs(
  target: PluginAssignmentTarget | null,
  draft: PluginsPanelDraft | null,
  acknowledgeMcp = false,
): PluginsAssignArgs | null {
  if (!target || !draft || !isEditableTarget(target)) return null;
  const pluginIds = dedupePluginIds(draft.pluginIds);
  const args: PluginsAssignArgs = target.kind === 'agent'
    ? { target: { kind: 'agent', name: target.name, baseHash: draft.baseHash }, pluginIds }
    : {
      target: {
        kind: 'template-slot',
        templateName: target.templateName,
        index: target.index,
        ref: target.ref,
        baseHash: draft.baseHash,
        mode: draft.mode ?? target.mode,
      },
      pluginIds,
    };
  if (acknowledgeMcp) args.acknowledgeMcp = true;
  return args;
}
