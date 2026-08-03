// input:  frozen benchmark policy and compiled runtime snapshots
// output: policy-backed resolver and re-resolution rejection proofs
// pos:    Regression suite for compile-once benchmark lookups
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { it } from 'vitest';
import type {
  AgentDefinition, AgentSlotConfig, ThreadTemplate,
} from '../../../src/core/types/thread-types.js';
import type { ResolvedProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import {
  createPolicyBackedResolutionDeps,
} from '../../../src/domain/benchmark/policy-backed-runtime-deps.js';
import {
  PolicyCompilationError, type ResolvedTrialPolicy,
} from '../../../src/domain/benchmark/resolved-policy.js';

function profile(): ResolvedProfileConfig {
  return {
    name: 'benchmark-profile', model: 'claude-sonnet', backend: 'claude', mode: 'api',
    provider: 'anthropic', extraEnv: {}, extraOption: {}, claudeBackend: 'print',
    thinking: 'high', fallback: [],
  };
}

function agent(): AgentDefinition {
  return {
    name: 'benchmark-coder', profile: '__active__', persistSession: false,
    directive: 'Implement the benchmark task.', tools: 'Read,Write',
  };
}

function resolvedAgent(): AgentSlotConfig {
  return {
    slotId: 'benchmark-coder', profile: '__active__', persistSession: false,
    directive: 'Implement the benchmark task.', tools: 'Read,Write',
  };
}

function template(): ThreadTemplate {
  return {
    name: 'benchmark-coder-review', description: 'fixture', agents: ['benchmark-coder'],
    transitions: [], entryAgent: 'benchmark-coder', maxTotalSteps: 1, disableHooks: true,
  };
}

function policy(): ResolvedTrialPolicy {
  return Object.freeze({
    child_template_whitelist: Object.freeze(['benchmark-coder-review']),
    model_execution: Object.freeze({
      backend: 'claude', requested_model: 'claude-sonnet', provider_protocol: 'anthropic',
      reasoning_effort: 'high', fallback_empty: true,
    }),
  }) as unknown as ResolvedTrialPolicy;
}

it('serves only compiled profile, template, and agent snapshots', () => {
  const selectedProfile = profile();
  const selectedTemplate = template();
  const selectedAgent = agent();
  const ambientTemplate = { ...selectedTemplate, name: 'ambient-template' };
  const deps = createPolicyBackedResolutionDeps(policy(), {
    profileName: selectedProfile.name,
    profile: selectedProfile,
    agents: { 'benchmark-coder': selectedAgent },
    templates: {
      'benchmark-coder-review': selectedTemplate,
      'ambient-template': ambientTemplate,
    },
    templateAgents: {
      'benchmark-coder-review': [resolvedAgent()],
      'ambient-template': [resolvedAgent()],
    },
  });

  assert.deepEqual(deps.resolveProfile('benchmark-profile'), selectedProfile);
  assert.deepEqual(deps.getTemplate('benchmark-coder-review'), selectedTemplate);
  assert.deepEqual(
    deps.resolveTemplateAgents(selectedTemplate).map(value => value.slotId),
    ['benchmark-coder'],
  );
  assert.deepEqual(Object.keys(deps.loadTemplates().templates), ['benchmark-coder-review']);
  assert.ok(Object.isFrozen(deps.resolveProfile('benchmark-profile')));
  assert.ok(Object.isFrozen(deps.getTemplate('benchmark-coder-review')));
  assert.throws(() => {
    deps.resolveProfile('benchmark-profile').model = 'mutated';
  }, TypeError);
});

it('reports runtime name lookups outside the frozen policy as code 23 JSON', () => {
  const lines: string[] = [];
  const deps = createPolicyBackedResolutionDeps(policy(), {
    profileName: 'benchmark-profile',
    profile: profile(),
    agents: { 'benchmark-coder': agent() },
    templates: { 'benchmark-coder-review': template() },
    templateAgents: { 'benchmark-coder-review': [resolvedAgent()] },
  }, { write: value => { lines.push(String(value)); return true; } });

  assert.throws(
    () => deps.getTemplate('ambient-template'),
    error => error instanceof PolicyCompilationError
      && error.reason === 'policy_reresolution_attempted' && error.failureClass === 'R',
  );
  assert.deepEqual(JSON.parse(lines[0]), {
    code: 23, failure_class: 'R', reason: 'policy_reresolution_attempted',
  });
});
