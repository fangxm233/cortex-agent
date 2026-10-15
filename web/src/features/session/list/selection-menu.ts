import type {
  ConfigAgentEntry, ConfigModels, EngineSelection, ModelCatalogSnapshot, ModelRef,
} from '@cortex-agent/ui-contract';
import { catalogModels, modelKey, modelLabel, selectionForModel } from '@/lib/model-selection';
import type { SelectionChange } from '@/features/session/state/selected-session';

export type EffectiveSelection = EngineSelection;
export interface ModelOption {
  id: string;
  backend: EngineSelection['backend'];
  provider: string | null;
  group: string;
  active: boolean;
  disabled: boolean;
  disabledReason: 'cross-backend' | null;
  favorite: boolean;
  selection: EngineSelection;
}
export interface AgentOption {
  name: string;
  description: string | null;
  active: boolean;
  disabled: boolean;
}
export interface ThinkingOption { level: string | null; active: boolean }
export interface ModeOption { mode: string; active: boolean }

function modelOption(
  ref: ModelRef, models: ConfigModels | null, current: EngineSelection,
  hasHistory: boolean, catalog?: ModelCatalogSnapshot | null,
): ModelOption {
  const disabled = hasHistory && ref.backend !== current.backend;
  return {
    id: ref.model, backend: ref.backend, provider: ref.provider,
    group: ref.provider ?? ref.backend, active: modelKey(ref) === modelKey(current),
    disabled, disabledReason: disabled ? 'cross-backend' : null,
    favorite: models?.favorites.some((entry) => modelKey(entry) === modelKey(ref)) ?? false,
    selection: selectionForModel(ref, models ? { models } : null, catalog),
  };
}

export function buildFavoriteOptions(
  models: ConfigModels | null, current: EngineSelection, opts: { hasHistory: boolean },
): ModelOption[] {
  return (models?.favorites ?? []).map((ref) => modelOption(ref, models, current, opts.hasHistory));
}

export function buildModelOptions(
  catalog: ModelCatalogSnapshot | null | undefined, models: ConfigModels | null,
  current: EngineSelection, opts: { hasHistory: boolean },
): ModelOption[] {
  return catalogModels(catalog).map((ref) => modelOption(ref, models, current, opts.hasHistory, catalog));
}

export function groupModelOptions(options: ModelOption[], currentBackend: string) {
  const groups: Array<{ group: string; backend: string; options: ModelOption[] }> = [];
  for (const option of options) {
    const existing = groups.find((entry) => entry.group === option.group && entry.backend === option.backend);
    if (existing) existing.options.push(option);
    else groups.push({ group: option.group, backend: option.backend, options: [option] });
  }
  return [...groups.filter((g) => g.backend === currentBackend), ...groups.filter((g) => g.backend !== currentBackend)];
}

function routeOf(catalog: ModelCatalogSnapshot | null | undefined, current: EngineSelection) {
  return catalog?.routes.find((route) => route.backend === current.backend && route.provider === current.provider);
}

export function buildThinkingOptions(catalog: ModelCatalogSnapshot | null | undefined, current: EngineSelection): ThinkingOption[] {
  const levels = routeOf(catalog, current)?.modelThinking?.[current.model]
    ?? catalog?.thinkingLevels?.[current.backend] ?? [];
  return [null, ...levels].map((level) => ({ level, active: level === current.thinking }));
}

export function buildModeOptions(catalog: ModelCatalogSnapshot | null | undefined, current: EngineSelection): ModeOption[] {
  const modes = routeOf(catalog, current)?.modes ?? [];
  return modes.length < 2 ? [] : modes.map((mode) => ({ mode, active: mode === current.mode }));
}

export function hasAgentChoice(agents: readonly unknown[]): boolean { return agents.length > 1; }
export function buildAgentOptions(agents: ConfigAgentEntry[], opts: { agentName: string | null }): AgentOption[] {
  return agents.map((agent) => ({
    name: agent.name, description: agent.description ?? null, active: agent.name === opts.agentName, disabled: false,
  }));
}
export function agentRowSub(option: AgentOption): string | null { return option.description; }
export function agentChipParts(options: AgentOption[], agentName: string | null) {
  const name = agentName ?? options.find((option) => option.name === 'main')?.name ?? null;
  return { name, description: options.find((option) => option.name === name)?.description ?? null, followingDefault: agentName === null };
}
export function selectionChipParts(selection: EngineSelection): { main: string; sub: string | null } {
  return { main: modelLabel(selection) || '—', sub: selection.thinking };
}
export function modelChange(current: EngineSelection, option: ModelOption): SelectionChange | null {
  if (option.disabled || modelKey(current) === modelKey(option.selection)) return null;
  return { selection: option.selection };
}
export function agentChange(options: AgentOption[], agentName: string | null, name: string | null): SelectionChange | null {
  if (name === agentName) return null;
  if (name !== null && !options.some((option) => option.name === name)) return null;
  return { agentName: name };
}
export function thinkingChange(current: EngineSelection, level: string | null): SelectionChange | null {
  return current.thinking === level ? null : { selection: { ...current, thinking: level } };
}
export function modeChange(current: EngineSelection, mode: string): SelectionChange | null {
  return current.mode === mode ? null : { selection: { ...current, mode } };
}
export interface SelectionRootRow { key: 'model' | 'thinking' | 'mode'; label: string; value: string }
export type SelectionPane = 'root' | SelectionRootRow['key'];
export function selectionRootRows(
  current: EngineSelection, copy: { model: string; thinking: string; mode: string; default?: string },
  opts: { hasThinking: boolean; hasModes: boolean },
): SelectionRootRow[] {
  return [
    { key: 'model', label: copy.model, value: current.model || '—' },
    ...(opts.hasThinking ? [{ key: 'thinking' as const, label: copy.thinking, value: current.thinking ?? copy.default ?? '—' }] : []),
    ...(opts.hasModes ? [{ key: 'mode' as const, label: copy.mode, value: current.mode || '—' }] : []),
  ];
}
