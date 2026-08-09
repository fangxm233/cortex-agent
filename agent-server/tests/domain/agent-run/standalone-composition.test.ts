// input:  public arm resolution, hostile ambient home, trial-local roots
// output: fresh standalone stores, assets, coordinator and output-only adapter proofs
// pos:    Construction contract for the installed benchmark agent-run root
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it, vi } from 'vitest';
import {
  createStandaloneAgentRunComposition,
} from '../../../src/domain/agent-run/standalone-composition.js';
import {
  runStandaloneBenchmarkThread,
} from '../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js';
import {
  createStandaloneStores,
} from '../../../src/domain/agent-run/standalone-stores.js';
import { openJournal } from '../../../src/domain/agent-run/journal.js';
import { writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';
import {
  FIXTURE_PROFILE, armResolution, writeFixtureAsset, writeTrialProfile,
} from '../benchmark/trial-thread-policy-fixture.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-composition-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const cli = writeFixtureAsset(root, 'bundle/claude', '#!/bin/sh\nexit 0\n', 0o755);
  const resolution = armResolution({ root, backend: 'claude', cli });
  const runConfigFile = writeFixtureAsset(root, 'arm-resolution.json', JSON.stringify(resolution));
  const workspace = path.join(root, 'workspace');
  const trajectoryRoot = path.join(root, 'agent', 'trajectory');
  const trialRoot = path.join(root, 'agent', 'trial-home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  return { runConfigFile, workspace, trajectoryRoot, trialRoot };
}

function createComposition(input: ReturnType<typeof fixture>) {
  return createStandaloneAgentRunComposition({
    ...input,
    cwd: input.workspace,
    agentSlot: 'parent',
    profileName: FIXTURE_PROFILE,
    rootRunId: 'trial-001.cortex-claude-coder-review',
    supervisor: { binary: process.execPath, graceMs: 1_000 },
    requireFresh: true,
  });
}

it('constructs the public projection without reading ambient profiles or stores', async () => {
  const input = fixture();
  writeTrialProfile('pi');

  const composition = createComposition(input);

  assert.equal(composition.policy.arm.backend, 'claude');
  assert.deepEqual(composition.profile, {
    name: FIXTURE_PROFILE,
    model: 'claude-sonnet',
    backend: 'claude',
    mode: null,
    provider: 'anthropic',
    extraEnv: {},
    extraOption: {},
    claudeBackend: 'print',
    thinking: null,
    fallback: [],
  });
  assert.equal(composition.paths.root, input.trialRoot);
  for (const value of Object.values(composition.paths)) {
    assert.equal(value === input.trialRoot || value.startsWith(`${input.trialRoot}${path.sep}`), true);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(
    input.trialRoot, 'cortex-home', 'config', 'profiles.json',
  ), 'utf8')), {
    defaultProfile: FIXTURE_PROFILE,
    profiles: { [FIXTURE_PROFILE]: {
      model: 'claude-sonnet', backend: 'claude', provider: 'anthropic',
      extraEnv: {}, extraOption: {}, claudeBackend: 'print', fallback: [],
    } },
  });
  assert.deepEqual(composition.stores.files, {
    tasks: path.join(input.trialRoot, 'cortex-home', 'state', 'tasks.json'),
    threads: path.join(input.trialRoot, 'cortex-home', 'state', 'threads.json'),
    sessions: path.join(input.trialRoot, 'cortex-home', 'state', 'sessions.json'),
    executions: path.join(input.trialRoot, 'cortex-home', 'state', 'executions.json'),
  });
  assert.deepEqual(composition.stores.tasks.getAll(), []);
  assert.deepEqual(composition.stores.threads.getAll(), []);
  assert.equal(composition.coordinator.portScope, 'fail-closed');
  assert.equal(composition.coordinator.eventBus, null);
  assert.equal(composition.coordinator.resolveProfile(FIXTURE_PROFILE).backend, 'claude');
  assert.equal(composition.coordinator.getTemplate('benchmark-coder-review')?.name,
    'benchmark-coder-review');
  assert.equal(composition.parentTrial.spawnConfig.pinnedEnv?.CORTEX_HOME,
    composition.paths.cortexHome);
  assert.equal(composition.parentTrial.spawnConfig.pinnedEnv?.CORTEX_PROJECTS_DIR,
    composition.paths.projectsDir);
  assert.equal(composition.output.kind, 'benchmark-output-only');
  assert.equal(composition.output.root, input.trajectoryRoot);
  assert.deepEqual(Object.keys(composition.output).sort(), [
    'kind', 'openJournal', 'root', 'threadAdapter', 'writeStarted', 'writeTerminal',
  ]);
  await assert.rejects(
    (composition.output.threadAdapter.postMessage as (...args: unknown[]) => Promise<unknown>)(),
    /no platform delivery capability/i,
  );

  const thread = composition.coordinator.createThread('benchmark:trial-001', {
    templateName: 'benchmark-coder-review',
    userMessage: 'Complete the task.',
    userMessageTs: '1',
    projectId: 'benchmark',
  });
  await Promise.all([
    composition.stores.threads.mutate(thread.id, record => { record.error = 'first'; }),
    composition.stores.threads.mutate(thread.id, record => { record.projectId = 'trial-project'; }),
  ]);
  await composition.stores.flush();
  const reopened = createStandaloneStores(composition.stores.root, false);
  assert.equal(thread.workspacePath.startsWith(`${input.trialRoot}${path.sep}`), true);
  assert.equal(reopened.threads.get(thread.id)?.error, 'first');
  assert.equal(reopened.threads.get(thread.id)?.projectId, 'trial-project');
  assert.equal(fs.existsSync(path.join(
    process.env.CORTEX_HOME as string, 'data', 'threads.json',
  )), false);
});

type Composition = ReturnType<typeof createComposition>;
type Fixture = ReturnType<typeof fixture>;

function seedParentLifecycle(input: Fixture, composition: Composition) {
  const instructionHash = createHash('sha256').update('Complete the task.').digest('hex');
  const journal = openJournal({
    path: path.join(input.trajectoryRoot, 'parent.journal.ndjson'),
    header: {
      rootRunId: composition.policy.root_run_id, threadId: null, agentSlot: 'parent',
      resolvedCwd: input.workspace, canonicalInstructionSha256: instructionHash,
      modelVisiblePromptSha256: instructionHash, systemPromptSha256: '1'.repeat(64),
      toolManifestSha256: '2'.repeat(64), pluginManifestSha256: '3'.repeat(64),
      modelExecutionIdentityHash: composition.policy.identity.model_execution_identity_hash.parent,
      roleToolSurfaceHash: composition.policy.identity.role_tool_surface_hash.parent,
      bundleManifestHash: composition.policy.identity.bundle_manifest_hash,
    },
  });
  journal.writeEvent({
    threadId: null, step: null, agentSlot: 'parent', backend: 'claude',
    provider: 'anthropic', requestedModel: 'claude-sonnet', reportedModel: 'fixture-model',
    event: { type: 'assistant_text', text: 'starting thread', model: 'fixture-model' },
  });
  writeStartedMarker({
    trajectoryRoot: input.trajectoryRoot, rootRunId: composition.policy.root_run_id,
    threadId: null, journalPath: journal.path,
  });
  return journal;
}

function fakeRunAgent(_message: string, options: any = {}) {
  const events = [
    { type: 'assistant_text', text: 'fake step complete', model: 'fixture-model' },
    { type: 'turn_complete', numTurns: 1, totalCostUsd: 0 },
  ];
  for (const event of events) {
    for (const sink of options.requiredSinks ?? []) sink.onEvent(event);
  }
  options.onAssistantMessage?.('fake step complete');
  return {
    sessionId: 'fake-session', agentProcess: null, kill: () => true,
    promise: Promise.resolve({
      finalOutput: 'fake step complete', sessionId: 'fake-session',
      total_cost_usd: 0, num_turns: 1, rateLimited: false,
      rateLimitMessage: null, planFilePath: null,
      enteredPlanMode: false, exitedPlanMode: false,
    }),
  };
}

function coordinatorRequest(input: Fixture, composition: Composition) {
  return {
    workspaceCwd: input.workspace, template: 'benchmark-coder-review',
    instruction: 'Complete the task.', profileName: FIXTURE_PROFILE,
    rootRunId: composition.policy.root_run_id, trajectoryRoot: input.trajectoryRoot,
    trialRoot: input.trialRoot, trialPolicy: composition.policy,
    limits: { maxSteps: 4, maxCostUsd: 1, deadlineEpochMs: Date.now() + 30_000 },
    signal: new AbortController().signal,
  };
}

it('runs the coordinator entirely against the injected trial-local dependencies', async () => {
  const input = fixture();
  const composition = createComposition(input);
  const parentJournal = seedParentLifecycle(input, composition);
  const coordinator = { ...composition.coordinator, runAgent: fakeRunAgent };
  const result = await runStandaloneBenchmarkThread(
    coordinatorRequest(input, composition), coordinator, composition.output,
  );

  await parentJournal.close();
  assert.equal(result.state, 'completed');
  assert.equal(result.manifestCommitted, true);
  assert.equal(composition.stores.threads.get(result.threadId)?.status, 'completed');
  assert.equal(fs.existsSync(path.join(
    process.env.CORTEX_HOME as string, 'data', 'threads.json',
  )), false);
});

it('refuses terminal publication when a required store flush fails', async () => {
  const input = fixture();
  const composition = createComposition(input);
  const parentJournal = seedParentLifecycle(input, composition);
  const coordinator = { ...composition.coordinator, runAgent: fakeRunAgent };
  await assert.rejects(
    runStandaloneBenchmarkThread(
      coordinatorRequest(input, composition), coordinator, composition.output,
      async () => { throw new Error('task store flush failed'); },
    ),
    /task store flush failed/,
  );
  await parentJournal.close();
  const terminals = fs.readdirSync(input.trajectoryRoot)
    .filter(name => name.startsWith('thread-') && name.endsWith('.terminal.json'));
  assert.deepEqual(terminals, []);
});

it('refuses an installed asset that changes after policy compilation', () => {
  const input = fixture();
  const resolution = JSON.parse(fs.readFileSync(input.runConfigFile, 'utf8'));
  const agentFile = resolution.thread_agents['benchmark-coder'] as string;
  const readFileSync = fs.readFileSync;
  let reads = 0;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, options: any) => {
    const value = readFileSync(file, options);
    if (String(file) !== agentFile || reads++ === 0) return value;
    return options ? `${String(value)}\n` : Buffer.concat([value as Buffer, Buffer.from('\n')]);
  }) as typeof fs.readFileSync);
  try {
    assert.throws(
      () => createComposition(input),
      /installed thread_agent asset changed after policy compilation/i,
    );
  } finally {
    spy.mockRestore();
  }
  assert.equal(reads >= 2, true);
});

it('refuses a non-fresh state root instead of resuming ambient trial state', () => {
  const input = fixture();
  const state = path.join(input.trialRoot, 'cortex-home', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'threads.json'), '{"host-thread":{}}');

  assert.throws(
    () => createComposition(input),
    /standalone trial root must be fresh/i,
  );
});

it('refuses physical state and output roots that escape through symlinks', () => {
  const stateInput = fixture();
  const outsideState = path.join(root, 'outside-state');
  fs.mkdirSync(outsideState);
  fs.symlinkSync(outsideState, stateInput.trialRoot);
  assert.throws(() => createComposition(stateInput), /trial root must be fresh/i);

  fs.unlinkSync(stateInput.trialRoot);
  const outputInput = fixture();
  const outsideOutput = path.join(root, 'outside-output');
  fs.mkdirSync(outsideOutput);
  fs.rmdirSync(outputInput.trajectoryRoot);
  fs.symlinkSync(outsideOutput, outputInput.trajectoryRoot);
  assert.throws(
    () => createComposition(outputInput),
    /state and output roots must share the physical trial root/i,
  );
});

it('rejects a symlinked shared-root ancestor before creating state or output', () => {
  const input = fixture();
  const outside = path.join(root, 'outside-container');
  const escapedRoot = path.join(root, 'agent', 'escaped-root');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, escapedRoot);
  input.trialRoot = path.join(escapedRoot, 'trial-home');
  input.trajectoryRoot = path.join(escapedRoot, 'trajectory');

  assert.throws(() => createComposition(input), /physical trial root/i);
  assert.equal(fs.existsSync(path.join(outside, 'trial-home')), false);
  assert.equal(fs.existsSync(path.join(outside, 'trajectory')), false);
});

it('rejects a replaced output root before opening a journal', async () => {
  const input = fixture();
  const composition = createComposition(input);
  const original = path.join(root, 'original-trajectory');
  const outside = path.join(root, 'outside-output-swap');
  fs.renameSync(input.trajectoryRoot, original);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, input.trajectoryRoot);

  let journal: ReturnType<typeof openJournal> | null = null;
  let thrown: unknown = null;
  try {
    journal = composition.output.openJournal({
      path: path.join(input.trajectoryRoot, 'escaped.journal.ndjson'),
      header: {
        rootRunId: composition.policy.root_run_id, threadId: null, agentSlot: 'parent',
        resolvedCwd: input.workspace, canonicalInstructionSha256: '0'.repeat(64),
        modelVisiblePromptSha256: '0'.repeat(64), systemPromptSha256: '1'.repeat(64),
        toolManifestSha256: '2'.repeat(64), pluginManifestSha256: '3'.repeat(64),
        modelExecutionIdentityHash:
          composition.policy.identity.model_execution_identity_hash.parent,
        roleToolSurfaceHash: composition.policy.identity.role_tool_surface_hash.parent,
        bundleManifestHash: composition.policy.identity.bundle_manifest_hash,
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    await journal?.close();
  }

  assert.equal(thrown instanceof Error, true);
  assert.match((thrown as Error).message, /physical trajectory root/i);
  assert.equal(fs.existsSync(path.join(outside, 'escaped.journal.ndjson')), false);
});

it('retains queued write failures for flush without an unhandled rejection', async () => {
  const stores = createStandaloneStores(path.join(root, 'failing-state'), true);
  fs.unlinkSync(stores.files.executions);
  fs.mkdirSync(stores.files.executions);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    stores.executions.startLocalExecution({ kind: 'local', trigger: 'test' });
    for (let attempt = 0; attempt < 20 && unhandled.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(unhandled, []);
    await assert.rejects(stores.flush());
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
