import type { ConfigSnapshot, ModelCatalogSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import { modelKey, modelLabel } from '@/lib/model-selection';

export interface ModelFact {
  ref: ModelRef;
  key: string;
  current: boolean;
  thinking: string | null;
}

function uniqueModels(refs: ModelRef[]): ModelRef[] {
  return [...new Map(refs.map(ref => [modelKey(ref), ref])).values()];
}

export function modelOptionLabel(ref: ModelRef): string {
  return [modelLabel(ref), ref.backend, ref.provider].filter(Boolean).join(' · ');
}

export function catalogModels(catalog: ModelCatalogSnapshot | null): ModelRef[] {
  return uniqueModels((catalog?.routes ?? []).flatMap(route => route.models.map(model => ({
    backend: route.backend, provider: route.provider, model,
  }))));
}

export function buildModelFacts(snapshot: ConfigSnapshot): ModelFact[] {
  const { favorites, memory, default: current } = snapshot.models;
  return favorites.map(ref => ({
    ref, key: modelKey(ref), current: !!current && modelKey(ref) === modelKey(current),
    thinking: memory[modelKey(ref)]?.thinking ?? null,
  }));
}

export function defaultModelOptions(snapshot: ConfigSnapshot, catalog: ModelCatalogSnapshot | null): ModelRef[] {
  const { default: current, favorites } = snapshot.models;
  return uniqueModels([...favorites, ...catalogModels(catalog), ...(current ? [current] : [])]);
}

export function groupModelFacts(facts: ModelFact[]): [string, ModelFact[]][] {
  const groups = new Map<string, ModelFact[]>();
  for (const fact of facts) {
    const label = [fact.ref.backend, fact.ref.provider].filter(Boolean).join(' · ');
    groups.set(label, [...(groups.get(label) ?? []), fact]);
  }
  return [...groups];
}
