import type { Backend } from '@core/types/agent-types.js';

/**
 * Which models an agent may name on its own when it delegates — a subagent's or a worker's
 * `model`. It bounds explicit picks only: a child that names nothing inherits its parent or the
 * configured defaults, which are the user's own choices.
 *
 * `allow` is the base set: every model, the configured ones (default and favorites), or the models
 * matching a pattern list. `deny` then removes models from that base. Patterns match a model's
 * delegation name — the bare id for Claude, `provider/model` for PI — with `*` as the only wildcard.
 */
export type DelegationAllow = 'all' | 'favorites' | string[];

export interface DelegationPolicy {
  allow: DelegationAllow;
  deny: string[];
}

export const DEFAULT_DELEGATION_POLICY: DelegationPolicy = { allow: 'favorites', deny: [] };

export interface DelegationModelRef {
  backend: Backend;
  provider?: string | null;
  model: string;
}

/** One model an agent named for a child, on the backend that child runs on. */
export interface DelegatedModelCheck {
  backend: Backend;
  /** The spec as written: `provider/model[:thinking]`, or a bare model id. */
  model: string;
  /** The delegating session's own model: naming it is no different from inheriting it. */
  parent?: DelegationModelRef | null;
}

/** Throws, with the models that are allowed, when the policy refuses the named model. */
export type CheckDelegatedModel = (check: DelegatedModelCheck) => void;

/** The name an agent writes for a model, and the name patterns match. */
export function delegationName(ref: DelegationModelRef): string {
  const model = ref.model.trim();
  const provider = ref.provider?.trim();
  return ref.backend === 'pi' && provider ? `${provider}/${model}` : model;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesModelPattern(pattern: string, name: string): boolean {
  const source = pattern.trim().split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`, 'i').test(name);
}

function inBase(allow: DelegationAllow, name: string, favorites: readonly string[]): boolean {
  if (allow === 'all') return true;
  if (allow === 'favorites') return favorites.includes(name);
  return allow.some((pattern) => matchesModelPattern(pattern, name));
}

/** `favorites` are the delegation names of the configured default and favorites. */
export function isDelegable(policy: DelegationPolicy, name: string, favorites: readonly string[]): boolean {
  if (!inBase(policy.allow, name, favorites)) return false;
  return !policy.deny.some((pattern) => matchesModelPattern(pattern, name));
}

function patternList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  return items.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []));
}

function parseAllow(value: unknown): DelegationAllow {
  if (value === 'all' || value === 'favorites') return value;
  return patternList(value) ?? DEFAULT_DELEGATION_POLICY.allow;
}

/** Read `models.json`'s `delegation` leniently: a bad field falls back to its default rather than
 *  failing every turn that reads the file. */
export function parseDelegationPolicy(raw: unknown): DelegationPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_DELEGATION_POLICY, deny: [] };
  const record = raw as Record<string, unknown>;
  return { allow: parseAllow(record.allow), deny: patternList(record.deny) ?? [] };
}

interface DelegatedTask {
  model?: string;
  backend?: Backend;
}

/** Check every task that names a model, before any child starts: a half-run fan-out is worse than
 *  none. `backendOf` is where the task's child runs. */
export function checkTaskModels<T extends DelegatedTask>(
  check: CheckDelegatedModel | undefined, tasks: readonly T[], backendOf: (task: T) => Backend,
  parent: DelegationModelRef | null,
): void {
  if (!check) return;
  for (const task of tasks) {
    if (task.model?.trim()) check({ backend: backendOf(task), model: task.model, parent });
  }
}
