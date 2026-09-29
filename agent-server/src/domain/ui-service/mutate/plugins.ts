import { t } from '@core/i18n.js';
import {
  CONFIG_TEMPLATES_DIR,
  loadConfig,
  loaderRefResolver,
} from '@domain/threads/template-loader.js';
import { isShellBinding } from '@domain/threads/shell-templates.js';
import { readEntity, readRawRegistry, saveEntity } from '@domain/threads/template-writer.js';
import {
  addedInvalidPluginIds,
  addedMcpPluginIds,
  canonicalManagedPluginDirs,
  normalizePluginDirs,
  normalizedDesiredPluginIds,
  pluginDirsOf,
  readPluginCatalogSnapshot,
  refName,
  samePluginIds,
} from '../plugins-shared.js';
import { fail, toErr } from './errors.js';
import type {
  PluginsAssignArgs,
  PluginsAssignReturn,
  Result,
  UiServiceDeps,
} from '../types.js';

type SlotTarget = Extract<PluginsAssignArgs['target'], { kind: 'template-slot' }>;
type PluginState = ReturnType<typeof normalizePluginDirs>;
type TemplateEntity = ReturnType<typeof readEntity>;

type SlotView = {
  body: Record<string, unknown>;
  refs: unknown[];
  current: unknown;
};

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

function saveWithReload(
  kind: 'agent' | 'template',
  name: string,
  body: Record<string, unknown>,
  baseHash: string,
): PluginsAssignReturn {
  const result = saveEntity(
    CONFIG_TEMPLATES_DIR,
    { kind, name, body, baseHash },
    loaderRefResolver(),
  );
  if (result.changed) loadConfig();
  return { changed: result.changed, baseHash: result.sha256 };
}

function assignAgentPlugins(args: PluginsAssignArgs): PluginsAssignReturn {
  if (args.target.kind !== 'agent') throw fail('invalid-args', 'agent target required');
  const snapshot = readPluginCatalogSnapshot();
  const entity = readEntity(CONFIG_TEMPLATES_DIR, 'agent', args.target.name);
  if (!entity.body) throw fail('invalid-args', `Agent '${args.target.name}' is not a JSON object`);
  const current = normalizePluginDirs(entity.body.pluginDirs, snapshot);
  const desired = requireDesiredPluginIds(current.managedIds, args.pluginIds, snapshot);
  requireMcpAck(current.managedIds, desired, args.acknowledgeMcp, snapshot);
  const next = { ...entity.body };
  const pluginDirs = [...canonicalManagedPluginDirs(desired), ...current.unmanaged];
  if (pluginDirs.length > 0) next.pluginDirs = pluginDirs;
  else delete next.pluginDirs;
  return saveWithReload('agent', args.target.name, next, args.target.baseHash);
}

function requireTemplateBody(entity: TemplateEntity, templateName: string): Record<string, unknown> {
  if (!entity.body) throw fail('invalid-args', `Template '${templateName}' is not a JSON object`);
  return entity.body;
}

function requireTemplateRefs(body: Record<string, unknown>, templateName: string): unknown[] {
  if (isShellBinding(body)) throw fail('invalid-args', t('ui.plugin.shellBinding', { name: templateName }));
  const refs = Array.isArray(body.agents) ? body.agents : null;
  if (!refs) throw fail('invalid-args', `Template '${templateName}' has no agents array`);
  return refs;
}

function requireSlotIndex(refs: unknown[], target: SlotTarget): unknown {
  if (target.index < 0 || target.index >= refs.length) {
    throw fail('invalid-args', `Template '${target.templateName}' has no slot ${target.index}`);
  }
  return refs[target.index];
}

function templateSlot(entity: TemplateEntity, target: SlotTarget): SlotView {
  if (entity.sha256 !== target.baseHash) throw fail('conflict', `template '${target.templateName}' changed on disk`);
  const body = requireTemplateBody(entity, target.templateName);
  const refs = requireTemplateRefs(body, target.templateName);
  return { body, refs, current: requireSlotIndex(refs, target) };
}

function inheritedState(
  ref: string,
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): PluginState {
  const registry = readRawRegistry(CONFIG_TEMPLATES_DIR);
  return normalizePluginDirs(pluginDirsOf(registry.agents[ref]), snapshot);
}

function slotState(
  slot: unknown,
  ref: string,
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): PluginState {
  if (Array.isArray(pluginDirsOf(slot))) return normalizePluginDirs(pluginDirsOf(slot), snapshot);
  return inheritedState(ref, snapshot);
}

function nextCustomSlot(
  slot: unknown,
  ref: string,
  managedIds: readonly string[],
  unmanaged: readonly string[],
): unknown {
  const pluginDirs = [...canonicalManagedPluginDirs(managedIds), ...unmanaged];
  if (typeof slot === 'string') return { ref, pluginDirs };
  return { ...(slot as Record<string, unknown>), ref, pluginDirs };
}

function nextInheritedSlot(slot: unknown): unknown {
  if (typeof slot === 'string') return slot;
  const next = { ...(slot as Record<string, unknown>) };
  delete next.pluginDirs;
  return next;
}

function writeInheritedSlot(
  current: unknown,
  ref: string,
  desired: readonly string[],
  inherited: PluginState,
): unknown {
  if (!samePluginIds(desired, inherited.managedIds)) {
    throw fail('invalid-args', `inherit mode for '${ref}' must match the agent's current managed plugins`);
  }
  return nextInheritedSlot(current);
}

function requireAssignableSlotRef(current: unknown, target: SlotTarget): string {
  const ref = refName(current);
  if (ref !== target.ref) throw fail('invalid-args', t('ui.plugin.slotRefChanged', { index: target.index, ref: target.ref }));
  if (ref === '__active__') throw fail('invalid-args', t('ui.plugin.slotReadOnly', { index: target.index }));
  if (!ref) throw fail('invalid-args', t('ui.plugin.slotNotAssignable', { index: target.index }));
  return ref;
}

function allowedSlotPluginIds(
  mode: SlotTarget['mode'],
  current: PluginState,
  inherited: PluginState,
): readonly string[] {
  return mode === 'inherit' ? inherited.managedIds : current.managedIds;
}

function nextSlotValue(
  mode: SlotTarget['mode'],
  current: unknown,
  ref: string,
  desired: readonly string[],
  currentState: PluginState,
  inherited: PluginState,
): unknown {
  return mode === 'custom'
    ? nextCustomSlot(current, ref, desired, currentState.unmanaged)
    : writeInheritedSlot(current, ref, desired, inherited);
}

function saveTemplateSlot(
  target: SlotTarget,
  slot: SlotView,
  next: unknown,
): PluginsAssignReturn {
  const body = { ...slot.body, agents: [...slot.refs] } as Record<string, unknown> & { agents: unknown[] };
  body.agents[target.index] = next;
  return saveWithReload('template', target.templateName, body, target.baseHash);
}

function assignTemplateSlotPlugins(args: PluginsAssignArgs): PluginsAssignReturn {
  if (args.target.kind !== 'template-slot') throw fail('invalid-args', 'template-slot target required');
  const snapshot = readPluginCatalogSnapshot();
  const slot = templateSlot(readEntity(CONFIG_TEMPLATES_DIR, 'template', args.target.templateName), args.target);
  const ref = requireAssignableSlotRef(slot.current, args.target);
  const current = slotState(slot.current, ref, snapshot);
  const inherited = inheritedState(ref, snapshot);
  const desired = requireDesiredPluginIds(
    allowedSlotPluginIds(args.target.mode, current, inherited),
    args.pluginIds,
    snapshot,
  );
  requireMcpAck(current.managedIds, desired, args.acknowledgeMcp, snapshot);
  return saveTemplateSlot(
    args.target,
    slot,
    nextSlotValue(args.target.mode, slot.current, ref, desired, current, inherited),
  );
}

export async function handlePluginsAssign(
  _deps: UiServiceDeps,
  args: PluginsAssignArgs,
): Promise<Result<PluginsAssignReturn>> {
  try {
    return {
      ok: true,
      data: args.target.kind === 'agent'
        ? assignAgentPlugins(args)
        : assignTemplateSlotPlugins(args),
    };
  } catch (error) {
    return toErr(error);
  }
}
