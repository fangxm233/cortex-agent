// input:  an arm-resolution document on disk, a parent started marker and the real orchestrator
// output: the derived trial-adapter route and the pre-spawn parent role-hash refusal
// pos:    Production wiring proof for the in-trial benchmark thread
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. Nothing here hands the orchestrator a pre-built object. The request carries two paths
// — `runConfigPath` and `trialRoot` — and the compiled policy, the resolved run config, the pinned
// trial paths and the supervisor descriptor are all derived from them by the shipped deriver, with
// one real compile of a real document. Both refusals are proved by counting `attachSupervisor`
// calls on the real spawn path, not by reading a return value.
// Design section 16 (16.3.2) PW1, PW2, PW4.

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  attachOptions: [] as { cwd?: string; args: string[]; env?: Record<string, string> }[],
  parentJournals: [] as any[],
}));

vi.mock('../../../src/domain/agents/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runAgent: vi.fn(() => { throw new Error('the unscoped daemon runAgent was reached'); }),
  getClaudeMode: () => 'api',
  closeSessionsByPrefix: () => {},
}));

vi.mock('../../../src/domain/agent-run/supervisor.js', async (importOriginal) => {
  const { spawn } = await import('node:child_process');
  return {
    ...await importOriginal<Record<string, unknown>>(),
    attachSupervisor: (options: any) => {
      harness.attachOptions.push({ cwd: options.cwd, args: options.args, env: options.env });
      const [command, ...args] = options.args;
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'pipe' });
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }));
        child.on('error', () => resolve({ code: 1, signal: null }));
      });
      return {
        process: child,
        started: Promise.resolve({ pid: child.pid, pgid: child.pid }),
        exited,
        quiescent: exited.then(() => {}),
        closed: exited,
        cancel: () => { child.kill('SIGTERM'); },
        dispose: async () => { child.kill('SIGKILL'); },
      };
    },
  };
});

import { CONFIG_DIR, DATA_DIR, DEFAULTS_DIR } from '../../../src/core/paths.js';
import { openJournal } from '../../../src/domain/agent-run/journal.js';
import { writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import {
  compileTrialPolicy, FIXTURE_MODEL, FIXTURE_PROFILE, writeFixtureAsset,
  type TrialPolicyFixture,
} from '../benchmark/trial-thread-policy-fixture.js';
import { writeFakeBackendCli, type FakeStepScript } from './fake-backend-cli.js';
import { seedShippedPrompts } from './benchmark-shipped-prompts.js';

const SHIPPED = path.join(DEFAULTS_DIR, 'config', 'thread-templates');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-wiring-'));
const TWO_STEPS: FakeStepScript[] = [{ text: 'coder done' }, { text: 'reviewer verdict' }];
let previousSupervisorBinary: string | undefined;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seedTemplates(): void {
  const base = path.join(CONFIG_DIR, 'thread-templates');
  for (const slot of ['benchmark-coder', 'benchmark-reviewer']) {
    const target = path.join(base, 'agents', `${slot}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SHIPPED, 'agents', `${slot}.json`), target);
  }
  writeJson(path.join(base, 'templates', 'fixture-two-step.json'), {
    name: 'fixture-two-step', description: 'fixture',
    agents: ['benchmark-coder', 'benchmark-reviewer'],
    transitions: [{
      from: 'benchmark-coder:implement', to: 'benchmark-reviewer:audit',
      condition: { type: 'always' },
    }],
    entryAgent: 'benchmark-coder', entryStage: 'implement',
    maxTotalSteps: 2, disableHooks: true,
  });
  fs.mkdirSync(path.join(base, 'shells'), { recursive: true });
  seedShippedPrompts();
}

function seedParentLifecycle(
  trajectoryRoot: string, rootRunId: string, workspaceCwd: string, roleToolSurfaceHash: string,
): void {
  const journal = openJournal({
    path: path.join(trajectoryRoot, `parent-${rootRunId}.journal.ndjson`),
    header: {
      rootRunId, threadId: null, agentSlot: 'parent', resolvedCwd: workspaceCwd,
      canonicalInstructionSha256: sha256Text('fix the fixture'),
      modelVisiblePromptSha256: sha256Text('fix the fixture'),
      systemPromptSha256: '1'.repeat(64), toolManifestSha256: '2'.repeat(64),
      pluginManifestSha256: '3'.repeat(64), modelExecutionIdentityHash: '6'.repeat(64),
      roleToolSurfaceHash, bundleManifestHash: '5'.repeat(64),
    },
  });
  journal.writeEvent({
    threadId: null, step: null, agentSlot: 'parent', backend: 'claude', provider: 'anthropic',
    requestedModel: FIXTURE_MODEL, reportedModel: null,
    event: { type: 'tool_use', toolUseId: 'thread-call', name: 'thread_run', input: {} },
  });
  harness.parentJournals.push(journal);
  writeStartedMarker({ trajectoryRoot, rootRunId, threadId: null, journalPath: journal.path });
}

interface TrialRun {
  request: any;
  fixture: TrialPolicyFixture;
  observations: string;
  cli: string;
  trialHome: string;
}

/** The production request shape: two paths, and nothing the orchestrator has to be handed. */
function prepareTrial(label: string, options: { parentHash?: string } = {}): TrialRun {
  const queue = writeFixtureAsset(root, `${label}/queue.json`, JSON.stringify(TWO_STEPS));
  const observations = path.join(root, label, 'observations');
  const cli = writeFakeBackendCli(root, label, 'claude', queue, observations);
  const fixture = compileTrialPolicy({ root: path.join(root, label), backend: 'claude', cli, label });
  seedTemplates();
  const workspaceCwd = path.join(root, label, 'workspace');
  fs.mkdirSync(workspaceCwd, { recursive: true });
  const trajectoryRoot = path.join(root, label, 'trajectory');
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  const rootRunId = `run-${label}`;
  seedParentLifecycle(
    trajectoryRoot, rootRunId, workspaceCwd,
    options.parentHash ?? fixture.policy.identity.role_tool_surface_hash.parent,
  );
  const trialHome = path.join(root, label, 'trial-home');
  return {
    request: {
      workspaceCwd, template: 'fixture-two-step', instruction: 'fix the fixture',
      profileName: FIXTURE_PROFILE, rootRunId, trajectoryRoot,
      runConfigPath: fixture.resolutionPath, trialRoot: DATA_DIR,
      limits: { maxSteps: 4, maxCostUsd: 1, deadlineEpochMs: Date.now() + 60_000 },
      signal: new AbortController().signal,
    },
    fixture, observations, cli, trialHome,
  };
}

async function orchestrator(): Promise<any> {
  return import('../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js');
}

/** Exactly what the MCP tool does: derive the adapter route from the two paths, then pass one
 *  override member. Nothing pre-built crosses the request boundary. */
async function runProductionRoute(run: TrialRun): Promise<any> {
  const api = await orchestrator();
  const { createBenchmarkTrialRunAgent } = await import(
    '../../../src/domain/benchmark/trial-thread-adapter.js'
  );
  const adapter = api.trialThreadAdapterInput(run.request.runConfigPath, run.trialHome);
  return api.runBenchmarkThread(
    { ...run.request, trialPolicy: adapter.policy },
    { runAgent: createBenchmarkTrialRunAgent(adapter) },
  );
}

beforeEach(() => {
  previousSupervisorBinary = process.env.CORTEX_SUPERVISOR_BINARY;
  process.env.CORTEX_SUPERVISOR_BINARY = process.execPath;
  harness.attachOptions.length = 0;
  jobCtx.bus = null;
});

afterAll(async () => {
  if (previousSupervisorBinary === undefined) delete process.env.CORTEX_SUPERVISOR_BINARY;
  else process.env.CORTEX_SUPERVISOR_BINARY = previousSupervisorBinary;
  await Promise.all(harness.parentJournals.map(journal => journal.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

// --- PW1/PW2: the route is derived from the two paths, by one compile of the named document ---

it('derives the whole trial-adapter route from the run config path and the trial root', async () => {
  const run = prepareTrial('derive');
  const api = await orchestrator();

  const derived = api.trialThreadAdapterInput(run.request.runConfigPath, run.trialHome);

  // The policy was compiled here, from the document the request names — not handed in.
  assert.equal(derived.policy.arm.name, run.fixture.policy.arm.name);
  assert.equal(
    derived.policy.identity.role_tool_surface_hash.parent,
    run.fixture.policy.identity.role_tool_surface_hash.parent,
  );
  assert.equal(derived.config.role.tools.length > 0, true);
  // The pinned paths come from `trialRoot`, and the supervisor from the shipped resolver.
  assert.equal(derived.paths.root, run.trialHome);
  assert.equal(derived.supervisor.binary, process.env.CORTEX_SUPERVISOR_BINARY);
  // LS3: a reader, so each step reads the state it was armed under.
  assert.equal(typeof derived.leaseState, 'function');
}, 30_000);

it('runs the in-trial thread through the derived route with one override member', async () => {
  const run = prepareTrial('run');

  const result = await runProductionRoute(run);

  assert.equal(result.state, 'completed', String(result.terminalReason));
  assert.equal(result.steps, 2);
  // Every step spawned the trial's own pinned CLI, which only the compiled policy names.
  assert.equal(harness.attachOptions.length, 2);
  for (const attach of harness.attachOptions) assert.equal(attach.args[0], run.cli);
  // The pinned trial environment reached the child: derived from `trialRoot`, not inherited.
  const observed = JSON.parse(fs.readFileSync(path.join(run.observations, 'step-0.json'), 'utf8'));
  assert.equal(observed.env.CORTEX_HOME, path.join(run.trialHome, 'cortex-home'));
}, 60_000);

it('refuses an override that supplies a lifecycle hook runner', async () => {
  const run = prepareTrial('lifecycle');
  const api = await orchestrator();

  await assert.rejects(
    api.runBenchmarkThread(run.request, { emitLifecycleHooks: undefined }),
    /may not supply a lifecycle hook runner/,
  );
  assert.equal(harness.attachOptions.length, 0);
}, 30_000);

// --- PW4: the parent's compile and this process's compile must agree, before any spawn ---

it('refuses before any spawn when the parent marker names another parent role surface', async () => {
  const run = prepareTrial('parent-drift', { parentHash: 'd'.repeat(64) });

  const result = await runProductionRoute(run);

  assert.notEqual(result.state, 'completed');
  assert.match(String(result.terminalReason), /protocol_violation/);
  // The refusal is pre-spawn: no process ever existed under the divergent parent identity.
  assert.equal(harness.attachOptions.length, 0);
}, 30_000);
