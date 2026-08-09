// input:  plugin assign args and template writes
// output: plugins.assign persistence and guards
// pos:    Mutate handler for plugin assignments
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CONFIG_TEMPLATES_DIR,
  loadConfig,
  loaderRefResolver,
} from '@domain/threads/template-loader.js';
import { isShellBinding } from '@domain/threads/shell-templates.js';
import { readEntity, saveEntity } from '@domain/threads/template-writer.js';
import { rawRegistryFromDir } from '@domain/threads/template-validate.js';
import {
  addedInvalidPluginIds,
  addedMcpPluginIds,
  canonicalManagedPluginDirs,
  normalizePluginDirs,
  normalizedDesiredPluginIds,
  readPluginCatalogSnapshot,
  samePluginIds,
} from '../plugins-shared.js';
import type {
  PluginsAssignArgs,
  PluginsAssignReturn,
  Result,
  UiServiceDeps,
} from '../types.js';

const IO = {
  readdirSync: (value: string) => readdirSync(value),
  readFileSync: (value: string, encoding: 'utf8') => readFileSync(value, encoding),
  existsSync,
  join: path.join,
};

type KnownCode = 'invalid-args' | 'not-found' | 'conflict';
type SlotTarget = Extract<PluginsAssignArgs['target'], { kind: 'template-slot' }>;
type PluginState = ReturnType<typeof normalizePluginDirs>;
type TemplateEntity = ReturnType<typeof readEntity>;

type SlotView = {
  body: Record<string, unknown>;
  refs: unknown[];
  current: unknown;
};

function fail(code: KnownCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function toErr(error: unknown): Result<never> {
  const code = (error as { code?: unknown }).code;
  return {
    ok: false,
    code: code === 'invalid-args' || code === 'not-found' || code === 'conflict' ? String(code) : 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}

function requireDesiredPluginIds(
  currentIds: readonly string[],
  pluginIds: readonly string[],
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): string[] {
  const desired = normalizedDesiredPluginIds(pluginIds);
  const invalid = addedInvalidPluginIds(currentIds, desired, snapshot);
  if (invalid.length > 0) throw fail('invalid-args', `Unassignable plugin ids: ${invalid.join(', ')}`);
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
  if (isShellBinding(body)) throw fail('invalid-args', `Template '${templateName}' is a read-only shell binding`);
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

function rawRefName(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && typeof (value as { ref?: unknown }).ref === 'string') {
    return (value as { ref: string }).ref;
  }
  return null;
}

function pluginDirsOf(value: unknown): unknown {
  return value && typeof value === 'object' ? (value as { pluginDirs?: unknown }).pluginDirs : undefined;
}

function inheritedState(
  ref: string,
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): PluginState {
  const registry = rawRegistryFromDir(CONFIG_TEMPLATES_DIR, IO);
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
  const ref = rawRefName(current);
  if (ref !== target.ref) throw fail('invalid-args', `Template slot ${target.index} no longer matches ref '${target.ref}'`);
  if (ref === '__active__') throw fail('invalid-args', `Template slot ${target.index} is read-only (__active__)`);
  if (!ref) throw fail('invalid-args', `Template slot ${target.index} is not assignable`);
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
