// input:  frozen trial policy and compile-time runtime snapshots
// output: policy-backed profile and template resolver dependencies
// pos:    Prevents watched benchmark assets from runtime re-resolution
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type {
  AgentDefinition, AgentSlotConfig, ThreadTemplate,
} from '../../core/types/thread-types.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import type { LocalThreadRuntimeDeps } from '../threads/local-runtime-deps.js';
import {
  PolicyCompilationError, reportBenchmarkFailure,
  type FailureStderr, type ResolvedTrialPolicy,
} from './resolved-policy.js';

export interface PolicyRuntimeSnapshot {
  profileName: string;
  profile: ResolvedProfileConfig;
  agents: Record<string, AgentDefinition>;
  templates: Record<string, ThreadTemplate>;
  templateAgents: Record<string, AgentSlotConfig[]>;
}

type ResolutionDeps = Pick<
  LocalThreadRuntimeDeps,
  'resolveProfile' | 'loadTemplates' | 'getTemplate' | 'resolveTemplateAgents'
>;

function freezeValue(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeValue(child);
  Object.freeze(value);
}

function frozenSnapshot(snapshot: PolicyRuntimeSnapshot): PolicyRuntimeSnapshot {
  const clone = structuredClone(snapshot);
  freezeValue(clone);
  return clone;
}

function reject(kind: string, name: string, stderr?: FailureStderr): never {
  const error = new PolicyCompilationError(
    'policy_reresolution_attempted', `${kind}:${name}`,
  );
  reportBenchmarkFailure(error, stderr);
  throw error;
}

function closedSnapshot(
  snapshot: PolicyRuntimeSnapshot,
  allowedTemplates: Set<string>,
): Pick<PolicyRuntimeSnapshot, 'agents' | 'templates' | 'templateAgents'> {
  const templates = Object.fromEntries(
    Object.entries(snapshot.templates).filter(([name]) => allowedTemplates.has(name)),
  );
  const templateAgents = Object.fromEntries(
    Object.entries(snapshot.templateAgents).filter(([name]) => allowedTemplates.has(name)),
  );
  const slots = new Set(Object.values(templateAgents).flat().map(agent => agent.slotId));
  const agents = Object.fromEntries(
    Object.entries(snapshot.agents).filter(([name]) => slots.has(name)),
  );
  const closed = { agents, templates, templateAgents };
  freezeValue(closed);
  return closed;
}

export function createPolicyBackedResolutionDeps(
  policy: ResolvedTrialPolicy,
  snapshot: PolicyRuntimeSnapshot,
  stderr?: FailureStderr,
): ResolutionDeps {
  const frozen = frozenSnapshot(snapshot);
  const allowedTemplates = new Set(policy.child_template_whitelist);
  const closed = closedSnapshot(frozen, allowedTemplates);
  const getTemplate = (name: string): ThreadTemplate => {
    const template = closed.templates[name];
    return template ?? reject('template', name, stderr);
  };
  return {
    resolveProfile: name => (
      name === frozen.profileName ? frozen.profile : reject('profile', name, stderr)
    ),
    loadTemplates: () => ({ agents: closed.agents, templates: closed.templates }),
    getTemplate,
    resolveTemplateAgents: template => (
      closed.templateAgents[getTemplate(template.name).name]
      ?? reject('template-agents', template.name, stderr)
    ),
  };
}
