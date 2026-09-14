// input:  ShellTemplateBinding + a ShellDefinition (pure JSON) + the loaded agents map
// output: expandShell / isShellBinding — GENERIC interpolation of a shell binding into a full
//         ThreadTemplate (no per-shell hardcoded function).
// pos:    DR-0017 D6 Phase 2.5 — shell transition graphs live in config (shells/*.json), not code.
//         The engine substitutes `{param}` (→ the binding's agent name) and `{param.entryStage}`
//         (→ that agent's entryStage) placeholders, then validates. The 7 validation semantics from
//         the old code-expander are preserved: missing param, unknown placeholder, agent not found,
//         missing entryStage, missing (retry) stage — plus unknown-shell handled by the loader.

import type {
  AgentDefinition,
  ThreadTemplate,
  ThreadHooks,
  ShellTemplateBinding,
  ShellDefinition,
} from '@core/types/thread-types.js';

/** Type guard: a config template entry is a shell binding (needs expansion) vs a full template. */
export function isShellBinding(value: unknown): value is ShellTemplateBinding {
  return typeof value === 'object' && value !== null && typeof (value as any).shell === 'string';
}

/** Resolve a single placeholder token (`param` or `param.entryStage`) to its string value. */
function resolveToken(
  token: string,
  name: string,
  binding: ShellTemplateBinding,
  shell: ShellDefinition,
  agents: Record<string, AgentDefinition>,
): string {
  const dot = token.indexOf('.');
  const param = dot < 0 ? token : token.slice(0, dot);
  const prop = dot < 0 ? '' : token.slice(dot + 1);

  if (!shell.params.includes(param)) {
    throw new Error(`shell template "${name}": unknown placeholder "{${token}}"`);
  }
  const value = binding[param];
  if (typeof value !== 'string' || !value) {
    throw new Error(`shell template "${name}": missing "${param}" binding`);
  }
  if (!prop) return value;

  if (prop === 'entryStage') {
    const agent = agents[value];
    if (!agent) throw new Error(`shell template "${name}": agent "${value}" not found`);
    if (!agent.entryStage) {
      throw new Error(`shell template "${name}": agent "${value}" has no entryStage`);
    }
    return agent.entryStage;
  }
  throw new Error(`shell template "${name}": unknown placeholder property "{${token}}"`);
}

/** Replace every `{token}` occurrence in a string via resolveToken. */
function interpolate(
  str: string,
  name: string,
  binding: ShellTemplateBinding,
  shell: ShellDefinition,
  agents: Record<string, AgentDefinition>,
): string {
  return str.replace(/\{([^}]+)\}/g, (_m, token) => resolveToken(token, name, binding, shell, agents));
}

/** A transition endpoint `agent:stage` (post-interpolation) must reference a stage the agent has. */
function validateEndpointStage(endpoint: string, name: string, agents: Record<string, AgentDefinition>): void {
  const idx = endpoint.indexOf(':');
  if (idx < 0) return; // bare agent, no stage to validate
  const agentName = endpoint.slice(0, idx);
  const stage = endpoint.slice(idx + 1);
  const agent = agents[agentName];
  if (!agent) return; // agent existence is validated separately via the agents list
  if (!agent.stages || !agent.stages[stage]) {
    throw new Error(`shell template "${name}": agent "${agentName}" has no "${stage}" stage`);
  }
}

function interpolateHooks(hooks: ThreadHooks, interp: (s: string) => string): ThreadHooks {
  const out: ThreadHooks = {};
  for (const phase of ['onStart', 'onTransition', 'onEnd'] as const) {
    const h = hooks[phase];
    if (!h) continue;
    out[phase] = {
      command: interp(h.command),
      ...(h.args ? { args: h.args.map(interp) } : {}),
      ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
    };
  }
  return out;
}

/**
 * Expand a shell binding into a full ThreadTemplate by interpolating the shell definition's
 * placeholder graph with the binding's parameter values. Throws (load-time error) on any of:
 * missing param, unknown placeholder, agent not found, missing entryStage, missing stage.
 */
export function expandShell(
  name: string,
  binding: ShellTemplateBinding,
  shell: ShellDefinition,
  agents: Record<string, AgentDefinition>,
): ThreadTemplate {
  // Missing-param check up front so "missing reviewer" fires regardless of placeholder order.
  for (const param of shell.params) {
    const value = binding[param];
    if (typeof value !== 'string' || !value) {
      throw new Error(`shell template "${name}": missing "${param}" binding`);
    }
  }

  const interp = (s: string) => interpolate(s, name, binding, shell, agents);

  const resolvedAgents = shell.agents.map(interp);
  for (const agentName of resolvedAgents) {
    if (!agents[agentName]) {
      throw new Error(`shell template "${name}": agent "${agentName}" not found`);
    }
  }

  const transitions = shell.transitions.map((t) => ({
    from: interp(t.from),
    to: interp(t.to),
    condition: { ...t.condition },
  }));
  for (const t of transitions) {
    validateEndpointStage(t.from, name, agents);
    validateEndpointStage(t.to, name, agents);
  }

  const entryAgent = interp(shell.entryAgent);
  const entryStage = shell.entryStage !== undefined ? interp(shell.entryStage) : undefined;

  const template: ThreadTemplate = {
    name,
    description: binding.description ?? `${binding.shell}: ${resolvedAgents.join(' → ')}`,
    agents: resolvedAgents,
    transitions,
    entryAgent,
    maxTotalSteps: binding.maxTotalSteps ?? shell.maxTotalSteps,
  };
  if (entryStage !== undefined) template.entryStage = entryStage;
  if (shell.maxTotalCostUsd !== undefined) template.maxTotalCostUsd = shell.maxTotalCostUsd;
  if (shell.hooks) template.hooks = interpolateHooks(shell.hooks, interp);

  return template;
}
