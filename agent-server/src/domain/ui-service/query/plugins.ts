// input:  plugin catalog, template registry, plugin DTOs
// output: plugins.list data with targets
// pos:    Query handler for plugin inventory
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_TEMPLATES_DIR } from '@domain/threads/template-loader.js';
import { isShellBinding } from '@domain/threads/shell-templates.js';
import { listEntityNames, readEntity } from '@domain/threads/template-writer.js';
import { rawRegistryFromDir, type RawRegistry } from '@domain/threads/template-validate.js';
import {
  normalizePluginDirs,
  readPluginCatalogSnapshot,
  sanitizePluginEntry,
} from '../plugins-shared.js';
import type {
  PluginAgentTarget,
  PluginTemplateShellBindingTarget,
  PluginTemplateSlotTarget,
  PluginsListParams,
  PluginsListReturn,
  UiServiceDeps,
} from '../types.js';

const IO = {
  readdirSync: (value: string) => readdirSync(value),
  readFileSync: (value: string, encoding: 'utf8') => readFileSync(value, encoding),
  existsSync,
  join: path.join,
};

function refName(ref: unknown): string | null {
  if (typeof ref === 'string' && ref.length > 0) return ref;
  if (ref && typeof ref === 'object' && typeof (ref as { ref?: unknown }).ref === 'string') {
    return (ref as { ref: string }).ref;
  }
  return null;
}

function pluginDirsOf(value: unknown): unknown {
  return value && typeof value === 'object' ? (value as { pluginDirs?: unknown }).pluginDirs : undefined;
}

function templateSlotState(
  registry: RawRegistry,
  ref: unknown,
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): { mode: 'inherit' | 'custom'; managedPluginIds: string[]; unmanagedPluginCount: number } {
  if (ref && typeof ref === 'object' && Array.isArray(pluginDirsOf(ref))) {
    const normalized = normalizePluginDirs(pluginDirsOf(ref), snapshot);
    return {
      mode: 'custom',
      managedPluginIds: normalized.managedIds,
      unmanagedPluginCount: normalized.unmanaged.length,
    };
  }
  const name = refName(ref);
  const normalized = normalizePluginDirs(name ? pluginDirsOf(registry.agents[name]) : undefined, snapshot);
  return {
    mode: 'inherit',
    managedPluginIds: normalized.managedIds,
    unmanagedPluginCount: normalized.unmanaged.length,
  };
}

function readAgentTargets(
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): PluginAgentTarget[] {
  const out: PluginAgentTarget[] = [];
  for (const name of listEntityNames(CONFIG_TEMPLATES_DIR, 'agent')) {
    const entity = readEntity(CONFIG_TEMPLATES_DIR, 'agent', name);
    if (!entity.body) continue;
    const normalized = normalizePluginDirs(pluginDirsOf(entity.body), snapshot);
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

function readTemplateTargets(
  registry: RawRegistry,
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
): Array<PluginTemplateSlotTarget | PluginTemplateShellBindingTarget> {
  const out: Array<PluginTemplateSlotTarget | PluginTemplateShellBindingTarget> = [];
  for (const name of listEntityNames(CONFIG_TEMPLATES_DIR, 'template')) {
    const entity = readEntity(CONFIG_TEMPLATES_DIR, 'template', name);
    const body = entity.body;
    if (!body || typeof body !== 'object') continue;
    if (isShellBinding(body)) {
      out.push({
        kind: 'template-shell',
        templateName: name,
        editable: false,
        baseHash: entity.sha256,
        readOnlyReason: 'shell-binding',
      });
      continue;
    }
    const refs = Array.isArray(body.agents) ? body.agents : [];
    refs.forEach((value, index) => {
      out.push(makeTemplateSlotTarget(name, entity.sha256, registry, snapshot, value, index));
    });
  }
  return out;
}

function activeTemplateSlotTarget(
  templateName: string,
  index: number,
  baseHash: string,
): PluginTemplateSlotTarget {
  return {
    kind: 'template-slot',
    templateName,
    index,
    ref: '__active__',
    editable: false,
    baseHash,
    mode: 'inherit',
    managedPluginIds: [],
    unmanagedPluginCount: 0,
    readOnlyReason: 'active-agent',
  };
}

function editableTemplateSlotTarget(
  templateName: string,
  index: number,
  ref: string,
  baseHash: string,
  state: ReturnType<typeof templateSlotState>,
): PluginTemplateSlotTarget {
  return {
    kind: 'template-slot',
    templateName,
    index,
    ref,
    editable: true,
    baseHash,
    mode: state.mode,
    managedPluginIds: state.managedPluginIds,
    unmanagedPluginCount: state.unmanagedPluginCount,
  };
}

function makeTemplateSlotTarget(
  templateName: string,
  baseHash: string,
  registry: RawRegistry,
  snapshot: ReturnType<typeof readPluginCatalogSnapshot>,
  ref: unknown,
  index: number,
): PluginTemplateSlotTarget {
  const name = refName(ref) ?? '';
  if (name === '__active__') return activeTemplateSlotTarget(templateName, index, baseHash);
  return editableTemplateSlotTarget(
    templateName,
    index,
    name,
    baseHash,
    templateSlotState(registry, ref, snapshot),
  );
}

export async function handlePluginsList(
  _deps: UiServiceDeps,
  _params: PluginsListParams,
): Promise<PluginsListReturn> {
  const snapshot = readPluginCatalogSnapshot();
  const registry = rawRegistryFromDir(CONFIG_TEMPLATES_DIR, IO);
  return {
    plugins: snapshot.entries.map((entry) => sanitizePluginEntry(entry)),
    targets: [...readAgentTargets(snapshot), ...readTemplateTargets(registry, snapshot)],
  };
}
