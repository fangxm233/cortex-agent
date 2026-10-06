import type { AgentRole } from '@core/agents/roles.js';
import type { SubagentTask } from './types.js';

/** A child's model selection: `provider/model[:thinking]`, every part optional. */
export interface ModelSpec {
  provider?: string;
  model?: string;
  thinking?: string;
}

/**
 * `provider/model[:thinking]`, every part optional: the provider is what precedes the first `/`,
 * the thinking level what follows the last `:`. Joining the parts back the same way reproduces the
 * string, which is what lets PI's own resolver see exactly what was written.
 *
 * A `claude` child keeps only `model` and `thinking` — a bare Claude model id has no provider
 * segment, so a spec carrying one was written for the other backend and its provider is dropped
 * rather than smuggled into `--model`.
 */
export function parseModelSpec(spec: string | undefined): ModelSpec {
  const trimmed = spec?.trim();
  if (!trimmed) return {};
  const colon = trimmed.lastIndexOf(':');
  const thinking = colon > 0 ? trimmed.slice(colon + 1).trim() || undefined : undefined;
  const rest = colon > 0 ? trimmed.slice(0, colon) : trimmed;
  const slash = rest.indexOf('/');
  if (slash < 0) return { model: rest || undefined, thinking };
  return {
    provider: rest.slice(0, slash) || undefined,
    model: rest.slice(slash + 1) || undefined,
    thinking,
  };
}

/**
 * A PI child's model: the task's spec, else the role's, else the delegating parent's own model.
 * A named spec is taken as written — the parent's provider is never grafted onto a model the task
 * or role named; only the parent's whole selection is the fallback. Resolved once, by whoever
 * launches the child, and handed down as is.
 */
export function selectChildModel(
  task: Pick<SubagentTask, 'model'>,
  role: Pick<AgentRole, 'model'>,
  parent?: { model?: string | null; provider?: string | null } | null,
): ModelSpec {
  const named = parseModelSpec(task.model?.trim() || role.model?.trim());
  if (named.model) return named;
  if (!parent?.model) return {};
  return { model: parent.model, ...(parent.provider ? { provider: parent.provider } : {}) };
}
