import type { ConfigSnapshot, EngineSelection, ModelCatalogSnapshot, ModelRef } from '@cortex-agent/ui-contract';

export function modelKey(ref: ModelRef): string {
  return JSON.stringify([ref.backend, ref.provider, ref.model]);
}

export function modelLabel(ref: ModelRef): string {
  return ref.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function selectionForModel(
  ref: ModelRef,
  config: Pick<ConfigSnapshot, 'models'> | null | undefined,
  catalog?: ModelCatalogSnapshot | null,
): EngineSelection {
  const remembered = config?.models.memory[modelKey(ref)];
  const route = catalog?.routes.find((entry) => entry.backend === ref.backend && entry.provider === ref.provider);
  return { ...ref, thinking: remembered?.thinking ?? null, mode: remembered?.mode ?? route?.modes[0] ?? '' };
}

export function catalogModels(catalog?: ModelCatalogSnapshot | null): ModelRef[] {
  return (catalog?.routes ?? []).flatMap((route) => route.models.map((model) => ({
    backend: route.backend, provider: route.provider, model,
  })));
}
