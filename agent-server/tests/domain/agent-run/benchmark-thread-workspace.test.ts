// input:  real orchestrator, real spawner and step loop, test-driven fake agents
// output: per-step placement, single-writer refusal, snapshot discard and artifact append
// pos:    Benchmark thread workspace placement and lease enforcement tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  attachOptions: [] as any[],
  observedProcessCwd: [] as string[],
  stepCwd: [] as string[],
  spawnPolicy: [] as Record<string, unknown>[],
  spawnErrors: [] as unknown[],
  observations: {} as Record<string, unknown>,
  parentJournals: [] as any[],
  runAgent: vi.fn(),
}));

vi.mock('../../../src/domain/agents/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runAgent: harness.runAgent,
  getClaudeMode: () => 'api',
  closeSessionsByPrefix: () => {},
}));

vi.mock('../../../src/domain/agent-run/supervisor.js', async (importOriginal) => {
  const { spawnSync } = await import('node:child_process');
  return {
    ...await importOriginal<Record<string, unknown>>(),
    attachSupervisor: (options: any) => {
      harness.attachOptions.push(options);
      // Far side of the spawn boundary: a real process started in the cwd the lease armed.
      const probe = spawnSync(process.execPath, ['-p', 'process.cwd()'], {
        cwd: options.cwd, encoding: 'utf8',
      });
      harness.observedProcessCwd.push(String(probe.stdout ?? '').trim());
      return {
        process: {},
        started: Promise.resolve({ pid: 1, pgid: 1 }),
        exited: Promise.resolve({ code: 0, signal: null }),
        quiescent: Promise.resolve(),
        closed: Promise.resolve({ code: 0, signal: null }),
        cancel: () => {},
        dispose: async () => {},
      };
    },
  };
});

import { CONFIG_DIR, DATA_DIR } from '../../../src/core/paths.js';
import type { NormalizedEvent } from '../../../src/agent-adapter/normalize/event-types.js';
import type { RunAgentOptions } from '../../../src/domain/agents/facade.js';
import { WorkspaceLeaseError } from '../../../src/domain/benchmark/workspace-lease.js';
import { openJournal } from '../../../src/domain/agent-run/journal.js';
import { writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

const MARKER = '[IMPL-APPROVED]';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-workspace-'));
const snapshotParent = path.join(DATA_DIR, 'tmp', 'review-snapshot');
let previousSupervisorBinary: string | undefined;

interface StepScript {
  /** Terminal assistant text this step ends with; null → the step emits none at all. */
  assistantText: string | null;
  /** Runs before the step spawns, with the options the real step loop built. */
  before?: (options: RunAgentOptions) => void;
  /** Overrides the cwd the step hands to the real spawner. */
  spawnCwd?: (options: RunAgentOptions) => string;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seedProfiles(): void {
  writeJson(path.join(CONFIG_DIR, 'profiles.json'), {
    defaultProfile: 'benchmark-fixture',
    profiles: {
      'benchmark-fixture': {
        model: 'fixture-model', backend: 'claude', claudeBackend: 'print',
        provider: 'anthropic', fallback: [],
      },
    },
  });
  profileRepo.invalidate();
}

function benchmarkAgent(name: string): Record<string, unknown> {
  return {
    name, profile: '__active__', persistSession: false,
    directive: `${name} directive`, systemPrompt: `${name} system`,
    promptTemplate: 'Complete {{input}}', tools: 'Read,Write', pluginDirs: [],
  };
}

function seedTemplates(): void {
  const base = path.join(CONFIG_DIR, 'thread-templates');
  writeJson(path.join(base, 'agents', 'benchmark-coder.json'), benchmarkAgent('benchmark-coder'));
  writeJson(path.join(base, 'agents', 'benchmark-reviewer.json'), benchmarkAgent('benchmark-reviewer'));
  writeJson(path.join(base, 'templates', 'fixture-two-step.json'), {
    name: 'fixture-two-step', description: 'fixture',
    agents: ['benchmark-coder', 'benchmark-reviewer'],
    transitions: [{ from: 'benchmark-coder', to: 'benchmark-reviewer', condition: { type: 'always' } }],
    entryAgent: 'benchmark-coder', maxTotalSteps: 2, disableHooks: true,
  });
  writeJson(path.join(base, 'templates', 'fixture-audit-retry.json'), {
    name: 'fixture-audit-retry', description: 'fixture',
    agents: ['benchmark-coder', 'benchmark-reviewer'],
    transitions: [
      { from: 'benchmark-coder', to: 'benchmark-reviewer', condition: { type: 'always' } },
      {
        from: 'benchmark-reviewer', to: 'benchmark-coder',
        condition: { type: 'convergence', marker: MARKER, maxIterations: 2 },
      },
    ],
    entryAgent: 'benchmark-coder', maxTotalSteps: 4, disableHooks: true,
  });
  fs.mkdirSync(path.join(base, 'shells'), { recursive: true });
}

function seedParentLifecycle(trajectoryRoot: string, rootRunId: string, workspaceCwd: string): void {
  const journal = openJournal({
    path: path.join(trajectoryRoot, `parent-${rootRunId}.journal.ndjson`),
    header: {
      rootRunId, threadId: null, agentSlot: 'parent', resolvedCwd: workspaceCwd,
      canonicalInstructionSha256: sha256Text('fix the fixture'),
      modelVisiblePromptSha256: sha256Text('fix the fixture'),
      systemPromptSha256: '1'.repeat(64), toolManifestSha256: '2'.repeat(64),
      pluginManifestSha256: '3'.repeat(64), modelExecutionIdentityHash: '6'.repeat(64),
      roleToolSurfaceHash: '4'.repeat(64), bundleManifestHash: '5'.repeat(64),
    },
  });
  journal.writeEvent({
    threadId: null, step: null, agentSlot: 'parent', backend: 'claude', provider: 'anthropic',
    requestedModel: 'fixture-model', reportedModel: null,
    event: { type: 'tool_use', toolUseId: 'thread-call', name: 'thread_run', input: {} },
  });
  harness.parentJournals.push(journal);
  writeStartedMarker({ trajectoryRoot, rootRunId, threadId: null, journalPath: journal.path });
}

function seedWorkspace(name: string): string {
  const workspaceCwd = path.join(root, name, 'workspace');
  fs.mkdirSync(workspaceCwd, { recursive: true });
  fs.writeFileSync(path.join(workspaceCwd, 'solution.txt'), 'shared original\n');
  return workspaceCwd;
}

function request(name: string, overrides: Record<string, unknown> = {}): any {
  const trajectoryRoot = path.join(root, name, 'trajectory');
  const workspaceCwd = seedWorkspace(name);
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  const value = {
    workspaceCwd, template: 'fixture-two-step', instruction: 'fix the fixture',
    profileName: 'benchmark-fixture', rootRunId: `run-${name}`, trajectoryRoot,
    trialRoot: DATA_DIR,
    limits: { maxSteps: 4, maxCostUsd: 1, deadlineEpochMs: Date.now() + 30_000 },
    signal: new AbortController().signal, ...overrides,
  };
  seedParentLifecycle(value.trajectoryRoot, value.rootRunId, value.workspaceCwd);
  return value;
}

function spawnPolicyOf(options: RunAgentOptions): Record<string, unknown> {
  return {
    cwd: options.cwd, mcpComposition: options.mcpComposition, disableHooks: options.disableHooks,
    loadCortexRules: (options as any).loadCortexRules, streamDeltas: (options as any).streamDeltas,
    captureTranscriptLogs: (options as any).captureTranscriptLogs,
    preserveUnreportedAccounting: (options as any).preserveUnreportedAccounting,
    recordCost: (options as any).recordCost, hasSpawner: options.processSpawner !== undefined,
  };
}

function queueStep(script: StepScript): void {
  harness.runAgent.mockImplementationOnce((_prompt: string, options: RunAgentOptions) => {
    harness.stepCwd.push(String(options.cwd));
    harness.spawnPolicy.push(spawnPolicyOf(options));
    script.before?.(options);
    try {
      options.processSpawner!(process.execPath, ['-e', ''], {
        cwd: script.spawnCwd ? script.spawnCwd(options) : options.cwd,
        env: process.env,
      });
    } catch (error) {
      harness.spawnErrors.push(error);
      throw error;
    }
    const events: NormalizedEvent[] = [];
    if (script.assistantText !== null) {
      events.push({ type: 'assistant_text', text: script.assistantText, model: 'fixture-model' });
    }
    events.push({ type: 'turn_complete', numTurns: 1, totalCostUsd: 0 });
    for (const event of events) {
      for (const sink of options.requiredSinks ?? []) sink.onEvent(event);
    }
    if (script.assistantText !== null) options.onAssistantMessage?.(script.assistantText);
    return {
      sessionId: 'fixture-session', agentProcess: null, kill: () => true,
      promise: Promise.resolve({
        finalOutput: script.assistantText, sessionId: 'fixture-session',
        total_cost_usd: 0, num_turns: 1, rateLimited: false,
      }),
    };
  });
}

async function runBenchmarkThread(value: any, overrides: Record<string, unknown> = {}): Promise<any> {
  const api = await import('../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js');
  return api.runBenchmarkThread(value, overrides as any);
}

function artifactOf(result: any): string {
  return fs.readFileSync(result.artifactPath, 'utf8');
}

function headerLines(artifact: string): string[] {
  return artifact.split('\n').filter(line => line.startsWith('--- snapshot step '));
}

function real(directory: string): string {
  return fs.realpathSync(directory);
}

beforeAll(() => {
  seedProfiles();
  seedTemplates();
}, 60_000);

beforeEach(() => {
  previousSupervisorBinary = process.env.CORTEX_SUPERVISOR_BINARY;
  process.env.CORTEX_SUPERVISOR_BINARY = process.execPath;
  harness.attachOptions.length = 0;
  harness.observedProcessCwd.length = 0;
  harness.stepCwd.length = 0;
  harness.spawnPolicy.length = 0;
  harness.spawnErrors.length = 0;
  harness.observations = {};
  harness.runAgent.mockReset();
  jobCtx.bus = null;
  fs.rmSync(snapshotParent, { recursive: true, force: true });
});

afterAll(async () => {
  if (previousSupervisorBinary === undefined) delete process.env.CORTEX_SUPERVISOR_BINARY;
  else process.env.CORTEX_SUPERVISOR_BINARY = previousSupervisorBinary;
  await Promise.all(harness.parentJournals.map(journal => journal.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

it('runs the two stages of a snapshot variant in two different process cwds', async () => {
  queueStep({ assistantText: 'coder done' });
  queueStep({
    assistantText: 'audit done',
    before: (options) => {
      harness.observations.snapshotRealPath = fs.realpathSync(String(options.cwd));
    },
  });
  const value = request('per-stage-placement', {
    template: 'fixture-two-step', coderReviewVariant: 'audit-retry',
  });

  const result = await runBenchmarkThread(value);

  assert.equal(result.state, 'completed');
  assert.equal(result.steps, 2);
  const expectedSnapshot = path.join(snapshotParent, result.threadId, '1');
  assert.deepEqual(harness.stepCwd, [value.workspaceCwd, expectedSnapshot]);
  assert.deepEqual(
    harness.attachOptions.map(options => options.cwd),
    [value.workspaceCwd, expectedSnapshot],
  );
  assert.equal(harness.observedProcessCwd.length, 2);
  assert.notEqual(harness.observedProcessCwd[0], harness.observedProcessCwd[1]);
  assert.equal(harness.observedProcessCwd[0], real(value.workspaceCwd));
  assert.equal(harness.observedProcessCwd[1], harness.observations.snapshotRealPath);
  assert.equal(fs.existsSync(snapshotParent), false);
});

it('keeps a single-placement run byte-identical to the shared writable root', async () => {
  queueStep({ assistantText: 'coder done' });
  queueStep({ assistantText: 'reviewer done' });
  const value = request('single-placement', { template: 'fixture-two-step' });

  const result = await runBenchmarkThread(value);

  assert.equal(result.state, 'completed');
  assert.deepEqual(harness.stepCwd, [value.workspaceCwd, value.workspaceCwd]);
  assert.deepEqual(harness.attachOptions.map(options => options.cwd), [
    value.workspaceCwd, value.workspaceCwd,
  ]);
  for (const policy of harness.spawnPolicy) {
    assert.deepEqual(policy, {
      cwd: value.workspaceCwd, mcpComposition: 'none', disableHooks: true, loadCortexRules: false,
      streamDeltas: false, captureTranscriptLogs: false, preserveUnreportedAccounting: true,
      recordCost: false, hasSpawner: true,
    });
  }
  assert.equal(fs.existsSync(snapshotParent), false);
  assert.equal(artifactOf(result).includes('--- snapshot step '), false);
});

it('refuses a second mutating spawn on the shared root with zero supervisor attachments', async () => {
  const value = request('single-writer', {
    template: 'fixture-two-step', coderReviewVariant: 'audit-retry',
  });
  queueStep({ assistantText: 'coder done' });
  // The reviewer is armed into its snapshot; it tries to run in the shared writable root instead.
  queueStep({ assistantText: 'audit done', spawnCwd: () => value.workspaceCwd });

  const result = await runBenchmarkThread(value);

  assert.equal(result.state, 'failed');
  assert.equal(harness.spawnErrors.length, 1);
  const refusal = harness.spawnErrors[0] as WorkspaceLeaseError;
  assert.ok(refusal instanceof WorkspaceLeaseError, `expected a lease refusal, got ${refusal}`);
  assert.equal(refusal.detail, 'cwd_outside_grant');
  // Only the coder's spawn ever reached the supervisor: no model process exists on the refusal.
  assert.equal(harness.attachOptions.length, 1);
  assert.deepEqual(harness.attachOptions.map(options => options.cwd), [value.workspaceCwd]);
  assert.equal(fs.existsSync(snapshotParent), false);
});

it('keeps the admission stop reason ahead of the lease check', async () => {
  queueStep({ assistantText: 'coder done' });
  queueStep({ assistantText: 'audit done', spawnCwd: () => '/nowhere-the-lease-armed' });
  const value = request('admission-first', {
    template: 'fixture-two-step', coderReviewVariant: 'audit-retry',
    limits: { maxSteps: 1, maxCostUsd: 1, deadlineEpochMs: Date.now() + 30_000 },
  });

  const result = await runBenchmarkThread(value);

  assert.equal(result.terminalReason, 'step_limit_exceeded');
  assert.equal(harness.spawnErrors.length, 1);
  assert.equal(harness.spawnErrors[0] instanceof WorkspaceLeaseError, false);
  assert.equal((harness.spawnErrors[0] as any).detail, 'max_steps');
  assert.equal(harness.attachOptions.length, 1);
});

it('discards the snapshot with its mutations before the next step runs', async () => {
  queueStep({ assistantText: 'coder done' });
  queueStep({
    assistantText: 'audit says retry',
    before: (options) => {
      const cwd = String(options.cwd);
      harness.observations.snapshotRoot = cwd;
      fs.writeFileSync(path.join(cwd, 'reviewer-scratch.txt'), 'created in the snapshot\n');
      fs.writeFileSync(path.join(cwd, 'solution.txt'), 'mutated in the snapshot\n');
    },
  });
  queueStep({
    assistantText: 'retry done',
    before: () => {
      const snapshotRoot = String(harness.observations.snapshotRoot);
      harness.observations.snapshotGoneAtNextStep = fs.existsSync(snapshotRoot) === false;
      harness.observations.parentGoneAtNextStep = fs.existsSync(snapshotParent) === false;
    },
  });
  queueStep({ assistantText: 'final audit done' });
  const value = request('snapshot-discard', {
    template: 'fixture-audit-retry', coderReviewVariant: 'audit-retry',
  });

  const result = await runBenchmarkThread(value);

  assert.equal(result.state, 'completed');
  assert.equal(harness.observations.snapshotGoneAtNextStep, true);
  assert.equal(harness.observations.parentGoneAtNextStep, true);
  assert.equal(fs.existsSync(path.join(value.workspaceCwd, 'reviewer-scratch.txt')), false);
  assert.equal(
    fs.readFileSync(path.join(value.workspaceCwd, 'solution.txt'), 'utf8'),
    'shared original\n',
  );
  assert.equal(fs.existsSync(snapshotParent), false);
});

it('makes a snapshot step verdict converge the real transition engine through the artifact file', async () => {
  queueStep({ assistantText: 'coder done' });
  queueStep({ assistantText: `audit passed ${MARKER}` });
  const value = request('append-converges', {
    template: 'fixture-audit-retry', coderReviewVariant: 'audit-retry',
  });

  const result = await runBenchmarkThread(value);

  assert.equal(result.state, 'completed');
  // Convergence is decided by reading the artifact file: the reviewer wrote nothing itself.
  assert.equal(result.steps, 2);
  assert.equal(harness.runAgent.mock.calls.length, 2);
  const artifact = artifactOf(result);
  assert.equal(headerLines(artifact).length, 1);
  assert.ok(artifact.includes(`audit passed ${MARKER}`));
  const header = headerLines(artifact)[0];
  assert.ok(header.includes('benchmark-reviewer'));
  assert.ok(header.includes('1'));
  assert.equal(header.includes('['), false);
  assert.equal(MARKER.startsWith(header.slice(-1)), false);
});

it('leaves the artifact marker-free, header included, when the verdict withholds it', async () => {
  queueStep({ assistantText: 'coder done' });
  queueStep({ assistantText: 'audit found problems' });
  queueStep({
    assistantText: 'retry done',
    before: (options) => {
      const thread = path.join(DATA_DIR, 'tmp', 'threads', String(options.threadId), 'artifact.md');
      harness.observations.artifactAtNextStep = fs.readFileSync(thread, 'utf8');
    },
  });
  queueStep({ assistantText: 'final audit found problems' });
  const value = request('append-retries', {
    template: 'fixture-audit-retry', coderReviewVariant: 'audit-retry',
  });

  const result = await runBenchmarkThread(value);

  assert.equal(result.steps, 4);
  const artifact = artifactOf(result);
  assert.equal(artifact.includes(MARKER), false);
  assert.equal(headerLines(artifact).length, 2);
  assert.ok(artifact.includes('audit found problems'));
  // The append landed before the transition that scheduled the next step was evaluated.
  const seenByNextStep = String(harness.observations.artifactAtNextStep);
  assert.ok(seenByNextStep.includes('audit found problems'));
  assert.equal(headerLines(seenByNextStep).length, 1);
});

it('appends nothing for a snapshot step that emits no assistant message', async () => {
  queueStep({ assistantText: 'coder done' });
  queueStep({ assistantText: null });
  const value = request('append-silent', {
    template: 'fixture-two-step', coderReviewVariant: 'audit-retry',
  });

  const result = await runBenchmarkThread(value);

  assert.equal(result.state, 'completed');
  assert.equal(result.steps, 2);
  const artifact = artifactOf(result);
  assert.equal(headerLines(artifact).length, 0);
  assert.equal(fs.existsSync(snapshotParent), false);
});

it('fails closed before any spawn when the artifact escapes the trial root', async () => {
  queueStep({ assistantText: 'must not run' });
  const value = request('artifact-outside-trial', {
    template: 'fixture-two-step', trialRoot: path.join(root, 'artifact-outside-trial', 'elsewhere'),
  });
  fs.mkdirSync(value.trialRoot, { recursive: true });

  await assert.rejects(runBenchmarkThread(value), /artifact/i);

  assert.equal(harness.runAgent.mock.calls.length, 0);
  assert.equal(harness.attachOptions.length, 0);
});
