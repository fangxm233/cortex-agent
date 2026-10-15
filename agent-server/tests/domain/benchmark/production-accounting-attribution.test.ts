// Drives a REAL attempt through `startAttempt` over a scripted PI backend (`pi-fake-runtime`). The
// `cost_record` reaches the run through `EngineSession.ingestExternal`, the engine seam for an event
// the turn did not produce. The backend settles without a cost record of its own, so each attempt
// produces exactly the one row under test.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { RunEvent } from '../../../src/agent-adapter/run-events.js';
import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../src/domain/benchmark/benchmark-types.js';
import {
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../src/domain/benchmark/production-attempt-identity.js';
import { startAttempt } from '../../../src/domain/runs/attempt.js';
import { engines, SessionEngines } from '../../../src/domain/runs/engines.js';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import type { RunRequest } from '../../../src/domain/runs/request.js';
import {
  attemptFromFixture, attemptOf, runRequestFixture, type RunRequestFixtureInput,
} from '../../run-request-fixture.js';
import {
  makeFakeRuntimeFactory, type FakeRuntimeFactory,
} from '../../agent-adapter/pi-fake-runtime.js';
import { getCostSummary } from '../../../src/domain/costs/cost-tracker.js';
import { CostRepo, costRepo } from '../../../src/store/cost-repo.js';

const SHA = 'b'.repeat(64);
let root: string;
let costsPath: string;
let evidenceContext: ProductionBenchmarkEvidenceContext;
let pool: SessionEngines;
let piFake: FakeRuntimeFactory;
const originalCostsPath = process.env.CORTEX_COSTS_FILE;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-accounting-'));
  costsPath = path.join(root, 'data', 'costs.jsonl');
  process.env.CORTEX_COSTS_FILE = costsPath;
  costRepo._testReset();
  piFake = makeFakeRuntimeFactory();
  const piAdapter = new PIAdapter(
    piFake.factory,
    path.join(root, 'pi-sessions'),
    undefined,
    { agentDir: path.join(root, 'pi-agent') },
  );
  pool = new SessionEngines({ pi: piAdapter });
  vi.spyOn(engines, 'acquire').mockImplementation((spec) => pool.acquire(spec));
  resetProductionAttemptIdentity();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pool.listKeys().map((key) => pool.close(key)));
  await costRepo.flush();
  resetProductionAttemptIdentity();
  if (originalCostsPath === undefined) delete process.env.CORTEX_COSTS_FILE;
  else process.env.CORTEX_COSTS_FILE = originalCostsPath;
  costRepo._testReset();
  fs.rmSync(root, { recursive: true, force: true });
});

function selection(): EngineSelection {
  return {
    model: 'deepseek-fixture', backend: 'pi', mode: 'trial', provider: 'deepseek', thinking: null,
  };
}

function initializeIdentity(): void {
  evidenceContext = {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: 'trial-accounting', root_run_id: 'root-accounting',
    bundle_manifest_hash: SHA,
    model_execution: {
      model_alias_policy: { policy: 'exact' }, cli_name: 'pi',
      cli_version: 'pi-fixture-1', max_output_tokens: null,
    },
  };
  initializeProductionAttemptIdentity({
    storePath: path.join(root, 'data', 'benchmark-attempt-identities.jsonl'),
  });
}

/** The `cost_record` the engine ingests for one attempt. */
function accountingEvent(
  values: {
    input: number | null; output: number | null;
    cacheRead: number | null; cacheCreation: number | null;
    requests: number | null; cost?: number | null;
  },
): Extract<RunEvent, { type: 'cost_record' }> {
  const prompt = values.input === null || values.cacheRead === null || values.cacheCreation === null
    ? null : values.input + values.cacheRead + values.cacheCreation;
  return {
    type: 'cost_record', provider: 'deepseek',
    model: 'pi-model', tokens_in: prompt, tokens_out: values.output,
    prompt_tokens: prompt, cached_tokens: values.cacheRead,
    input_tokens: values.input, output_tokens: values.output,
    cache_read_tokens: values.cacheRead, cache_creation_tokens: values.cacheCreation,
    provider_requests: values.requests, cost_usd: values.cost === undefined ? 0.02 : values.cost,
  };
}

async function runAttempt(
  suffix: string,
  event: Extract<RunEvent, { type: 'cost_record' }>,
): Promise<void> {
  const resolved = selection();
  const override = attemptOf(resolved);
  const partial: RunRequestFixtureInput = {
    sessionKey: `engine-${suffix}`,
    trackSessionId: 'session-accounting',
    model: resolved.model,
    piProvider: resolved.provider,
   
    tools: 'Read',
    pluginDirs: [],
    mcpComposition: 'none',
    disableHooks: true,
    loadCortexRules: false,
    recordCost: true,
    project: 'cortex-self',
    trigger: 'user',
  };
  const base = runRequestFixture(partial, override);
  const request: RunRequest = {
    ...base,
    benchmark: {
      evidenceContext,
      identityDirective: '',
    },
  };
  const piIndex = piFake.runtimes.length;
  const handle = startAttempt({
    request,
    attempt: attemptFromFixture(partial, override),
    executionId: `exec-${suffix}`,
    onEvent: () => {},
  });
  // Ingest before the backend settles, so the row is billed to the foreground turn (the run layer
  // stops recording once `foreground_result` lands).
  handle.engine.ingestExternal(event);
  const runtime = await piFake.runtime(piIndex);
  await runtime.nextCall('prompt');
  runtime.emitAgentEnd({ provider: '', settle: true });
  await handle.settled;
}

test('accounting keeps reported zero and unavailable distinct across concurrent attempts and reload', async () => {
  initializeIdentity();
  const suffixes = ['zero', 'unknown', 'known'];
  await Promise.all([
    runAttempt('zero', accountingEvent({
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 1, cost: null,
    })),
    runAttempt('unknown', accountingEvent({
      input: null, output: null, cacheRead: null, cacheCreation: null, requests: null,
    })),
    runAttempt('known', accountingEvent({
      input: 10, output: 2, cacheRead: 7, cacheCreation: 3, requests: 2,
    })),
  ]);
  await costRepo.flush();

  const expectedAttempts = new Map(suffixes.map((suffix) => [
    suffix, getProductionAttemptIdentity(`exec-${suffix}`)?.attempt_id,
  ]));
  resetProductionAttemptIdentity();
  const reloaded = await new CostRepo({
    costsPath, budgetPath: path.join(root, 'config', 'budget.json'),
  }).readCosts();
  assert.equal(reloaded.entries.length, 3);

  const rows = new Map(reloaded.entries.map((entry) => [entry.execution_id, entry]));
  const zero = rows.get('exec-zero');
  const unknown = rows.get('exec-unknown');
  assert.ok(zero);
  assert.ok(unknown);
  assert.deepEqual({
    cost: zero.cost_usd, input: zero.input_tokens, output: zero.output_tokens,
    cacheRead: zero.cache_read_tokens, cacheCreation: zero.cache_creation_tokens,
    requests: zero.provider_requests,
  }, { cost: null, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 1 });
  assert.deepEqual({
    input: unknown.input_tokens, output: unknown.output_tokens,
    cacheRead: unknown.cache_read_tokens, cacheCreation: unknown.cache_creation_tokens,
    requests: unknown.provider_requests,
  }, { input: null, output: null, cacheRead: null, cacheCreation: null, requests: null });

  for (const suffix of suffixes) {
    const row = rows.get(`exec-${suffix}`);
    assert.ok(row);
    assert.equal(row.session_id, 'session-accounting');
    assert.equal('thread_id' in row, false);
    assert.equal('task_id' in row, false);
    assert.equal(row.attempt_id, expectedAttempts.get(suffix));
    assert.equal(row.root_run_id, 'root-accounting');
  }

  const summary = await getCostSummary('cortex-self');
  assert.equal(summary.entryCount, 3);
  assert.equal(summary.tokens.total.input, 20);
  assert.equal(summary.tokens.total.output, 2);
});
