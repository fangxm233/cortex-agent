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
  const connection = ref.backend === 'pi' ? null : remembered?.connection ?? route?.connections[0] ?? null;
  return { ...ref, thinking: remembered?.thinking ?? null, connection };
}

/** Whether a selection is ready to apply: PI's provider is its connection, so PI always is; Claude
 *  needs a connection from memory or the catalog route. */
export function hasRoute(selection: EngineSelection): boolean {
  return selection.backend === 'pi' || selection.connection !== null;
}

export function catalogModels(catalog?: ModelCatalogSnapshot | null): ModelRef[] {
  return (catalog?.routes ?? []).flatMap((route) => route.models.map((model) => ({
    backend: route.backend, provider: route.provider, model,
  })));
}

export function matchesModelFilter(model: string, filter: string): boolean {
  return model.toLowerCase().includes(filter.trim().toLowerCase());
}
