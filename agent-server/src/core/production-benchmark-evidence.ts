// input:  untrusted production benchmark evidence values
// output: validated immutable evidence context
// pos:    Canonicalizes benchmark admission facts
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type {
  ProductionBenchmarkEvidenceContext,
  ProductionBenchmarkIdentityJsonValue,
} from './types/thread-types.js';

const CONTEXT_SCHEMA = 'cortex-production-benchmark-evidence-context/1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function invalid(detail: string): Error {
  return new Error(`Production benchmark evidence context invalid: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => expected.has(key));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(label);
  return value;
}

function cloneJsonValue(value: unknown): ProductionBenchmarkIdentityJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJsonValue)) as ProductionBenchmarkIdentityJsonValue;
  if (!isRecord(value)) throw invalid('model_execution.model_alias_policy');
  const entries = Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]);
  return Object.freeze(Object.fromEntries(entries)) as ProductionBenchmarkIdentityJsonValue;
}

function parseModelExecution(value: unknown): ProductionBenchmarkEvidenceContext['model_execution'] {
  const keys = ['model_alias_policy', 'cli_name', 'cli_version', 'max_output_tokens'];
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw invalid('model_execution');
  if (value.cli_name !== 'claude' && value.cli_name !== 'pi') {
    throw invalid('model_execution.cli_name');
  }
  const max = value.max_output_tokens;
  if (max !== null && (!Number.isInteger(max) || Number(max) <= 0)) {
    throw invalid('model_execution.max_output_tokens');
  }
  return Object.freeze({
    model_alias_policy: cloneJsonValue(value.model_alias_policy),
    cli_name: value.cli_name,
    cli_version: requiredText(value.cli_version, 'model_execution.cli_version'),
    max_output_tokens: max as number | null,
  });
}

export function parseProductionBenchmarkEvidenceContext(
  value: unknown,
): ProductionBenchmarkEvidenceContext {
  const keys = ['schema_version', 'trial_id', 'root_run_id', 'bundle_manifest_hash', 'model_execution'];
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw invalid('evidence context envelope');
  if (value.schema_version !== CONTEXT_SCHEMA) throw invalid('schema_version');
  const bundle = requiredText(value.bundle_manifest_hash, 'bundle_manifest_hash');
  if (!SHA256_PATTERN.test(bundle)) throw invalid('bundle_manifest_hash');
  return Object.freeze({
    schema_version: CONTEXT_SCHEMA,
    trial_id: requiredText(value.trial_id, 'trial_id'),
    root_run_id: requiredText(value.root_run_id, 'root_run_id'),
    bundle_manifest_hash: bundle,
    model_execution: parseModelExecution(value.model_execution),
  });
}
