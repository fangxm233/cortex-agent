import { afterEach, expect, test, vi } from 'vitest';
import { runRequestFixture } from '../../run-request-fixture.js';
import { bindSessionEvidenceContext, _resetSessionEvidence } from '../../../src/domain/benchmark/session-evidence.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../src/domain/benchmark/benchmark-types.js';

vi.mock('../../../src/domain/runs/run.js', () => ({
  AgentRunImpl: class {
    request: unknown;
    constructor(args: { request: unknown }) { this.request = args.request; }
    start() {}
  },
}));
vi.mock('../../../src/domain/executions/registry.js', () => ({
  startLocalExecution: () => ({ id: 'exec' }), teardownExecution: vi.fn(),
}));
import { startRun } from '../../../src/domain/runs/service.js';

const context: ProductionBenchmarkEvidenceContext = {
  schema_version: 'cortex-production-benchmark-evidence-context/1',
  trial_id: 'trial', root_run_id: 'root', bundle_manifest_hash: 'a'.repeat(64),
  model_execution: { cli_name: 'pi', cli_version: '1', model_alias_policy: null, max_output_tokens: 8192 },
};
afterEach(_resetSessionEvidence);

test('every run of a bound benchmark session receives the webhook output cap', () => {
  bindSessionEvidenceContext('session', context, 8192);
  for (let turn = 0; turn < 2; turn++) {
    const request = runRequestFixture({ trackSessionId: 'session' });
    request.benchmark = { evidenceContext: context, identityDirective: '' };
    const run = startRun(request, []);
    expect(run.request.benchmarkMaxOutputTokens).toBe(8192);
    expect(request.benchmarkMaxOutputTokens).toBeUndefined();
  }
});

test('a non-benchmark run cannot pick up a session-bound cap', () => {
  bindSessionEvidenceContext('session', context, 8192);
  const request = runRequestFixture({ trackSessionId: 'session' });
  expect(startRun(request, []).request.benchmarkMaxOutputTokens).toBeUndefined();
});

test('explicit benchmark requests keep their cap for identity validation', () => {
  bindSessionEvidenceContext('session', context, 8192);
  const request = runRequestFixture({ trackSessionId: 'session', benchmarkMaxOutputTokens: 4096 });
  request.benchmark = { evidenceContext: context, identityDirective: '' };
  expect(startRun(request, []).request.benchmarkMaxOutputTokens).toBe(4096);
});
