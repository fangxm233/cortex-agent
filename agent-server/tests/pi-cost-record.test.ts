// input:  PIAdapter over a fake PI runtime + runWithAdapter + cost-tracker
// output: Per-run PI cost recording with settled completion
// pos:    PI cost record end-to-end integration path
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';

import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import { makeFakeRuntimeFactory } from './agent-adapter/pi-fake-runtime.js';
import { _test as modeManagerTest } from '../src/domain/agents/index.js';
import type { AgentAdapter } from '../src/agent-adapter/index.js';
import { CAPABILITIES_BY_BACKEND } from '../src/agent-adapter/index.js';
import type { AgentSpawnConfig } from '../src/agent-adapter/types.js';
import type { CostEntry } from '../src/domain/costs/cost-tracker.js';
import { costRepo } from '../src/store/cost-repo.js';

const { runWithAdapter } = modeManagerTest;

// Temp session dir (isolated per test run)
const SESSION_DIR = pathJoin(tmpdir(), `pi-cost-record-test-${process.pid}`);
mkdirSync(SESSION_DIR, { recursive: true });

// Temp costs file (isolated from production costs.json)
const COSTS_FILE = pathJoin(tmpdir(), `pi-cost-record-costs-${process.pid}.json`);
const ORIGINAL_COSTS_FILE = process.env['CORTEX_COSTS_FILE'];

// --- Cleanup (N2H-3: afterAll() ensures env is restored even on assertion failure) ---

afterAll(() => {
  if (ORIGINAL_COSTS_FILE !== undefined) {
    process.env['CORTEX_COSTS_FILE'] = ORIGINAL_COSTS_FILE;
  } else {
    delete process.env['CORTEX_COSTS_FILE'];
  }
  if (existsSync(COSTS_FILE)) {
    unlinkSync(COSTS_FILE);
  }
  // Reset the singleton so the next test file gets a clean state
  costRepo._testReset();
});

// ---------------------------------------------------------------------------
// Integration test: direct-pi run → cost entry with provider/model/tokens
// ---------------------------------------------------------------------------

test('pi-cost-record: agent_end records cost before agent_settled completes', async () => {
  // Redirect cost tracking to isolated temp file
  process.env['CORTEX_COSTS_FILE'] = COSTS_FILE;
  costRepo._testReset();

  const fake = makeFakeRuntimeFactory({ sessionId: 'pi-test-001' });
  const piAdapter = new PIAdapter(fake.factory, SESSION_DIR);

  // Wrap PIAdapter as AgentAdapter for runWithAdapter
  const adapter: AgentAdapter = {
    backend: 'pi',
    capabilities: CAPABILITIES_BY_BACKEND['pi'],
    spawn: (config: AgentSpawnConfig) => piAdapter.spawn(config),
    close: (key: string) => piAdapter.close(key),
    kill: (key: string) => piAdapter.kill(key),
    listSessions: () => piAdapter.listSessions(),
  };

  // runWithAdapter calls adapter.spawn() synchronously inside, which creates the PI session.
  const handle = runWithAdapter(
    adapter,
    'hello',
    { project: 'pi-cost-test', trigger: 'test' },
    { model: '', backend: 'pi', mode: 'api' },
    undefined,
  );

  // The session announces itself once its runtime resolved and hands PI the opening prompt.
  const runtime = await fake.runtime();
  await runtime.nextCall('prompt');

  // agent_end records low-level usage; agent_settled terminates the Cortex turn.
  runtime.emitAgentStart();
  runtime.emit({
    type: 'agent_end',
    messages: [
      {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-opus-4',
        usage: {
          input: 200, output: 100, cacheRead: 20, cacheWrite: 10,
          cost: { total: 0.005 },
        },
      },
    ],
  });
  runtime.emit({ type: 'agent_settled' });

  // Wait for runWithAdapter to finish processing.
  await handle.promise;
  for (const key of piAdapter.listSessions()) await piAdapter.close(key);
  // Drain any pending async cost writes (recordCost is fire-and-forget in mode-manager event loop).
  await costRepo.flush();

  // --- Assertions ---

  assert.ok(existsSync(COSTS_FILE), 'costs file should exist after cost_record was processed');
  const raw = readFileSync(COSTS_FILE, 'utf8');
  const lines = raw.trim().split('\n').filter(l => l).map(l => JSON.parse(l) as CostEntry);
  assert.ok(lines.length > 0, 'costs file should have at least one entry (JSONL format)');
  const piEntries = lines.filter(e => e.backend === 'pi');
  assert.equal(piEntries.length, 1, 'exactly one PI cost entry should be recorded (no double-recording)');

  const entry = piEntries[0];
  assert.equal(entry.backend, 'pi', 'backend should be pi');
  assert.equal(entry.provider, 'anthropic', 'provider should be anthropic');
  assert.equal(entry.model, 'claude-opus-4', 'model should match agent_end message');
  assert.equal(entry.input_tokens, 200, 'input_tokens should match usage.input');
  assert.equal(entry.output_tokens, 100, 'output_tokens should match usage.output');
  assert.equal(entry.prompt_tokens, 230, 'prompt total includes both cache token categories');
  assert.equal(entry.cache_read_tokens, 20, 'cache reads preserve the provider report');
  assert.equal(entry.cache_creation_tokens, 10, 'cache writes preserve the provider report');
  assert.equal(entry.provider_requests, 1, 'one assistant request was observed');
  assert.ok(
    Math.abs((entry.cost_usd ?? 0) - 0.005) < 0.0001,
    `cost_usd should be ~0.005, got ${entry.cost_usd}`,
  );
  assert.equal(entry.project, 'pi-cost-test', 'project should match runWithAdapter options');
  assert.equal(entry.trigger, 'test', 'trigger should match runWithAdapter options');
});
