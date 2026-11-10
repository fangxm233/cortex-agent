import {
  delegationName, isDelegable, parseDelegationPolicy,
  type DelegatedModelCheck, type DelegationModelRef, type DelegationPolicy,
} from '@core/agents/subagent/delegation-policy.js';
import { parseModelSpec, type ModelSpec } from '@core/agents/subagent/model-spec.js';
import type { Backend } from '@core/types/agent-types.js';
import { modelsRepo } from '@store/models-repo.js';
import { modelCatalog, type CatalogSnapshot } from '../models/catalog.js';
import { resolveModelRef } from './models.js';

/** The longest allowed-model list a refusal spells out. */
const MAX_LISTED = 30;

export interface DelegationRules {
  policy: DelegationPolicy;
  /** Delegation names of the configured default and favorites. */
  favorites: string[];
}

type ModelsFileView = NonNullable<ReturnType<typeof modelsRepo.readIfPresent>>;

function configuredRefs(file: ModelsFileView): DelegationModelRef[] {
  const refs: unknown[] = [file.default, ...(Array.isArray(file.favorites) ? file.favorites : [])];
  return refs.filter((ref): ref is DelegationModelRef => {
    const candidate = ref as DelegationModelRef | null;
    return !!candidate && typeof candidate.model === 'string' && !!candidate.model.trim();
  });
}

const UNRESTRICTED: DelegationRules = { policy: { allow: 'all', deny: [] }, favorites: [] };

/** The policy and favorites as `models.json` holds them now. A host with no readable file has no
 *  configured models to restrict to, so it restricts nothing. */
export function delegationRules(): DelegationRules {
  let file: ReturnType<typeof modelsRepo.readIfPresent> = null;
  try { file = modelsRepo.readIfPresent(); } catch { /* reported by every other reader */ }
  if (!file) return UNRESTRICTED;
  return {
    policy: parseDelegationPolicy(file.delegation),
    favorites: configuredRefs(file).map(delegationName),
  };
}

/** True when the rules restrict nothing, so no lookup is worth doing. */
function unrestricted(rules: DelegationRules): boolean {
  return rules.policy.allow === 'all' && rules.policy.deny.length === 0;
}

/** A predicate over model refs for the current rules. */
export function delegableFilter(rules: DelegationRules = delegationRules()): (ref: DelegationModelRef) => boolean {
  if (unrestricted(rules)) return () => true;
  return (ref) => isDelegable(rules.policy, delegationName(ref), rules.favorites);
}

/** Every model the rules admit, by delegation name, sorted: the catalog's, plus the configured ones
 *  a cold catalog (a CLI process) may not list yet. */
export function delegableNames(
  rules: DelegationRules = delegationRules(), snapshot: CatalogSnapshot = modelCatalog.peek(),
): string[] {
  const catalogued = snapshot.routes.flatMap((route) => route.models
    .map((model) => delegationName({ backend: route.backend, provider: route.provider, model })));
  const names = [...catalogued, ...rules.favorites]
    .filter((name) => isDelegable(rules.policy, name, rules.favorites));
  return [...new Set(names)].sort();
}

/** A bare PI name is looked up the way `resolveModelRef` does; an unknown one stays bare. */
function requestedName(backend: Backend, spec: ModelSpec & { model: string }): string {
  if (backend === 'claude') return spec.model;
  if (spec.provider) return `${spec.provider}/${spec.model}`;
  try { return delegationName(resolveModelRef(spec.model, 'pi')); }
  catch { return spec.model; }
}

function isParentModel(check: DelegatedModelCheck, name: string): boolean {
  const parent = check.parent;
  if (!parent?.model || parent.backend !== check.backend) return false;
  return delegationName(parent) === name;
}

function refusal(name: string, rules: DelegationRules): string {
  const allowed = delegableNames(rules);
  if (!allowed.length) return `Model "${name}" is not available for delegation, and no model is; omit model to use the default.`;
  const listed = allowed.slice(0, MAX_LISTED).join(', ');
  const more = allowed.length > MAX_LISTED ? `, and ${allowed.length - MAX_LISTED} more` : '';
  return `Model "${name}" is not available for delegation. Choose one of: ${listed}${more}; or omit model to use the default.`;
}

/**
 * Refuse a model an agent named that the delegation policy does not admit. Only explicit names are
 * checked; naming the delegating session's own model is the same as inheriting it.
 */
export function checkDelegatedModel(check: DelegatedModelCheck): void {
  const spec = parseModelSpec(check.model);
  if (!spec.model) return;
  const rules = delegationRules();
  if (unrestricted(rules)) return;
  const name = requestedName(check.backend, { ...spec, model: spec.model });
  if (isParentModel(check, name) || isDelegable(rules.policy, name, rules.favorites)) return;
  throw new Error(refusal(name, rules));
}
