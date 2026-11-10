import type { ConfigSnapshot, ModelCatalogSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import { modelKey, modelLabel, type ConnectionNames } from '@/lib/model-selection';
import { buildConnectionOptions, defaultConnectionLabel } from '@/features/session/list/selection-menu';

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

export interface DefaultConnectionControl {
  /** '' follows the default connection. */
  value: string;
  options: { value: string; label: string }[];
}

/** The connection choice for the default model, offered under the same rule as the composer's:
 *  only when more than one connection serves it. `copy` is the composer's Default-row copy. */
export function defaultConnectionControl(
  snapshot: Pick<ConfigSnapshot, 'models'>, catalog: ModelCatalogSnapshot | null, names: ConnectionNames,
  copy: { withConnection: string; plain: string },
): DefaultConnectionControl | null {
  const current = snapshot.models.default;
  if (!current) return null;
  const options = buildConnectionOptions(catalog, current, defaultConnectionLabel(catalog, current, names, copy), names);
  if (options.length === 0) return null;
  return {
    value: current.connection ?? '',
    options: options.map(option => ({ value: option.id ?? '', label: option.label })),
  };
}

export type DelegationPolicy = NonNullable<ConfigSnapshot['models']['delegation']>;
export type DelegationMode = 'favorites' | 'all' | 'custom';

export function delegationMode(policy: DelegationPolicy): DelegationMode {
  return Array.isArray(policy.allow) ? 'custom' : policy.allow;
}

/** The name agents write for a model: the bare id for Claude, provider/model for PI. */
function delegationName(ref: ModelRef): string {
  return ref.backend === 'pi' && ref.provider ? `${ref.provider}/${ref.model}` : ref.model;
}

/** Switching to custom patterns starts from the models agents could already name. */
export function policyWithMode(policy: DelegationPolicy, mode: DelegationMode, snapshot: ConfigSnapshot): DelegationPolicy {
  if (mode !== 'custom') return { ...policy, allow: mode };
  if (Array.isArray(policy.allow)) return policy;
  const { default: current, favorites } = snapshot.models;
  const names = [...(current ? [current] : []), ...favorites].map(delegationName);
  return { ...policy, allow: [...new Set(names)] };
}

/** Patterns as typed: separated by commas or whitespace, blanks and repeats dropped. */
export function parsePatterns(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map(part => part.trim()).filter(Boolean))];
}

export function delegationModeOptions(copy: {
  stDelegationFavorites: string; stDelegationAll: string; stDelegationCustom: string;
}): Array<{ value: DelegationMode; label: string }> {
  return [
    { value: 'favorites', label: copy.stDelegationFavorites },
    { value: 'all', label: copy.stDelegationAll },
    { value: 'custom', label: copy.stDelegationCustom },
  ];
}
