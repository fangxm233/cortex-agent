import type { Backend } from '@core/types/agent-types.js';

export type ProductionBenchmarkIdentityJsonValue =
  | null | boolean | number | string
  | ProductionBenchmarkIdentityJsonValue[]
  | { [key: string]: ProductionBenchmarkIdentityJsonValue };

/** The launcher's facts about one production benchmark trial, attached to the session it runs. */
export interface ProductionBenchmarkEvidenceContext {
  readonly schema_version: 'cortex-production-benchmark-evidence-context/1';
  readonly trial_id: string;
  readonly root_run_id: string;
  readonly bundle_manifest_hash: string;
  readonly model_execution: {
    readonly model_alias_policy: ProductionBenchmarkIdentityJsonValue;
    readonly cli_name: Backend;
    readonly cli_version: string;
    readonly max_output_tokens: number | null;
  };
}
