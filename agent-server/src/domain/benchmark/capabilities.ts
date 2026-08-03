// input:  validated benchmark arm orchestration
// output: closed child-template and broker capability lists
// pos:    Compile-time admission whitelist derivation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ArmDefinition } from './arm-schema.js';

export type BenchmarkBrokerCapability =
  | 'task.read'
  | 'task.create'
  | 'task.decompose'
  | 'task.claim'
  | 'task.propose_complete'
  | 'task.propose_block'
  | 'artifact.write'
  | 'dependency.declare'
  | 'qa.ask'
  | 'qa.answer';

const CODER_REVIEW_CAPABILITIES: BenchmarkBrokerCapability[] = [
  'artifact.write', 'task.read',
];

const MANAGER_CAPABILITIES: BenchmarkBrokerCapability[] = [
  'artifact.write',
  'dependency.declare',
  'task.claim',
  'task.create',
  'task.decompose',
  'task.propose_block',
  'task.propose_complete',
  'task.read',
];

const CHILD_TEMPLATES_BY_MODE = {
  direct: [],
  manager: ['benchmark-coder-review', 'benchmark-manager'],
} as const;

const CODER_TEMPLATE_BY_VARIANT = {
  'audit-retry': 'benchmark-coder-review',
  'reviewer-fix': 'benchmark-coder-review-fix',
} as const;

const CAPABILITIES_BY_MODE = {
  direct: [],
  'coder-review': CODER_REVIEW_CAPABILITIES,
  manager: MANAGER_CAPABILITIES,
} as const;

function sorted<T extends string>(values: T[]): T[] {
  return [...values].sort();
}

export function childTemplateWhitelistForArm(arm: ArmDefinition): string[] {
  if (arm.kind !== 'cortex') return [];
  const orchestration = arm.orchestration!;
  if (orchestration.mode === 'coder-review') {
    return [CODER_TEMPLATE_BY_VARIANT[orchestration.coder_review_variant!]];
  }
  return [...CHILD_TEMPLATES_BY_MODE[orchestration.mode]];
}

export function capabilityWhitelistForArm(
  arm: ArmDefinition,
): BenchmarkBrokerCapability[] {
  if (arm.kind !== 'cortex') return [];
  const orchestration = arm.orchestration!;
  const capabilities: BenchmarkBrokerCapability[] = [
    ...CAPABILITIES_BY_MODE[orchestration.mode],
  ];
  if (orchestration.mode === 'manager' && orchestration.ask_manager) {
    capabilities.push('qa.ask', 'qa.answer');
  }
  return sorted(capabilities);
}
