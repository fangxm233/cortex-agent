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

type ThinkingCopy = { stThinkingBackendDefault: string; stThinkingUnsupported: string };

function favoriteThinkingLevels(ref: ModelRef, catalog: ModelCatalogSnapshot | null): string[] | null {
  if (!catalog || (ref.backend === 'pi' && catalog.piPending)) return null;
  const allowed = catalog.thinkingLevels?.[ref.backend];
  if (!allowed) return null;
  const route = catalog.routes.find(entry => entry.backend === ref.backend && entry.provider === ref.provider);
  const levels = route?.modelThinking?.[ref.model] ?? allowed;
  return [...new Set(levels.filter(level => allowed.includes(level)))];
}

export function thinkingFromValue(value: string): string | null {
  return value === '' ? null : value;
}

export function favoriteThinkingControl(fact: ModelFact, catalog: ModelCatalogSnapshot | null, copy: ThinkingCopy) {
  const levels = favoriteThinkingLevels(fact.ref, catalog);
  const options: { value: string; label: string; disabled?: boolean }[] = [
    { value: '', label: copy.stThinkingBackendDefault },
    ...(levels ?? []).map(level => ({ value: level, label: level })),
  ];
  if (fact.thinking !== null && !levels?.includes(fact.thinking)) {
    const label = levels === null ? fact.thinking : `${fact.thinking} · ${copy.stThinkingUnsupported}`;
    options.push({ value: fact.thinking, label, disabled: true });
  }
  return { value: fact.thinking ?? '', options, disabled: levels === null };
}

export function groupModelFacts(facts: ModelFact[]): [string, ModelFact[]][] {
  const groups = new Map<string, ModelFact[]>();
  for (const fact of facts) {
    const label = [fact.ref.backend, fact.ref.provider].filter(Boolean).join(' · ');
    groups.set(label, [...(groups.get(label) ?? []), fact]);
  }
  return [...groups];
}
