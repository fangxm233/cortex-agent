// input:  the authored two-stage reviewer-fix template, a compiled arm and real child CLIs
// output: this variant's own stage count, shared placement, surviving fix and proposal decision
// pos:    Reviewer-fix variant path proof for the in-trial benchmark thread
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. Nothing here is shared with the other variant: the template is the authored
// `benchmark-coder-review-fix` document with its own two stages, and every placement assertion
// names the one shared writable root that only this variant uses for every role. The far side of
// every seam is real — the real orchestrator, the real step loop, the real lease and its spawner,
// the real trial adapter, the real backend adapter and one real child process per step. The fix
// itself is written by that child, in the cwd the lease armed, not by the test process.

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
  unscopedRunAgent: vi.fn(() => { throw new Error('the unscoped daemon runAgent was reached'); }),
}));

vi.mock('../../../src/domain/agents/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runAgent: harness.unscopedRunAgent,
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
import type { Backend } from '../../../src/agent-adapter/types.js';
import { openJournal } from '../../../src/domain/agent-run/journal.js';
import { validateTrajectoryLifecycle, writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';
import { preparePinnedTrialPaths } from '../../../src/domain/agent-run/pinned-node-process.js';
import { createBenchmarkTrialRunAgent } from '../../../src/domain/benchmark/trial-thread-adapter.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import {
  compileTrialPolicy, FIXTURE_MODEL, FIXTURE_PROFILE, writeFixtureAsset,
} from '../benchmark/trial-thread-policy-fixture.js';
import { writeFakeBackendCli, type FakeStepScript } from './fake-backend-cli.js';

const SHIPPED = path.join(DEFAULTS_DIR, 'config', 'thread-templates');
const TEMPLATE = 'benchmark-coder-review-fix';
const FIX_MARKER = '[FIX-VERIFIED]';
const APPROVAL_MARKER = '[IMPL-APPROVED]';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-reviewer-fix-'));
const snapshotParent = path.join(DATA_DIR, 'tmp', 'review-snapshot');
let previousSupervisorBinary: string | undefined;

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The authored documents themselves, so the two stages under test are the ones that ship. */
function seedShippedDocuments(): void {
  const base = path.join(CONFIG_DIR, 'thread-templates');
  for (const [kind, name] of [
    ['agents', 'benchmark-coder'], ['agents', 'benchmark-fixer'], ['templates', TEMPLATE],
  ] as const) {
    const target = path.join(base, kind, `${name}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SHIPPED, kind, `${name}.json`), target);
  }
  fs.mkdirSync(path.join(base, 'shells'), { recursive: true });
}

function seedParentLifecycle(
  trajectoryRoot: string, rootRunId: string, workspaceCwd: string, backend: Backend,
): void {
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
    threadId: null, step: null, agentSlot: 'parent', backend, provider: 'anthropic',
    requestedModel: FIXTURE_MODEL, reportedModel: null,
    event: { type: 'tool_use', toolUseId: 'thread-call', name: 'thread_run', input: {} },
  });
  harness.parentJournals.push(journal);
  writeStartedMarker({ trajectoryRoot, rootRunId, threadId: null, journalPath: journal.path });
}

interface TrialRun {
  request: any;
  overrides: Record<string, unknown>;
  observations: string;
  workspaceCwd: string;
  trajectoryRoot: string;
  rootRunId: string;
}

function prepareTrial(
  label: string, backend: Backend, steps: FakeStepScript[],
  overrides: Record<string, unknown> = {},
): TrialRun {
  const queue = writeFixtureAsset(root, `${label}/queue.json`, JSON.stringify(steps));
  const observations = path.join(root, label, 'observations');
  const cli = writeFakeBackendCli(root, label, backend, queue, observations);
  const fixture = compileTrialPolicy({
    root: path.join(root, label), backend, cli, label, variant: 'reviewer-fix',
  });
  seedShippedDocuments();
  const workspaceCwd = path.join(root, label, 'workspace');
  fs.mkdirSync(workspaceCwd, { recursive: true });
  fs.writeFileSync(path.join(workspaceCwd, 'solution.txt'), 'shared original\n');
  const trajectoryRoot = path.join(root, label, 'trajectory');
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  const rootRunId = `run-${label}`;
  seedParentLifecycle(trajectoryRoot, rootRunId, workspaceCwd, backend);
  return {
    request: {
      workspaceCwd, template: TEMPLATE, instruction: 'fix the fixture',
      profileName: FIXTURE_PROFILE, rootRunId, trajectoryRoot, trialRoot: DATA_DIR,
      coderReviewVariant: 'reviewer-fix', trialPolicy: fixture.policy,
      limits: { maxSteps: 4, maxCostUsd: 1, deadlineEpochMs: Date.now() + 60_000 },
      signal: new AbortController().signal, ...overrides,
    },
    overrides: {
      runAgent: createBenchmarkTrialRunAgent({
        policy: fixture.policy, config: fixture.config,
        paths: preparePinnedTrialPaths(path.join(root, label, 'trial-home')),
        supervisor: { binary: process.execPath, graceMs: 1_000 },
      }),
    },
    observations, workspaceCwd, trajectoryRoot, rootRunId,
  };
}

async function runBenchmarkThread(run: TrialRun): Promise<any> {
  const api = await import('../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js');
  return api.runBenchmarkThread(run.request, run.overrides as any);
}

function ranStep(run: TrialRun, index: number): boolean {
  return fs.existsSync(path.join(run.observations, `step-${index}.json`));
}

function artifactOf(result: any): string {
  return fs.readFileSync(result.artifactPath, 'utf8');
}

function journalRecords(result: any): any[] {
  return fs.readFileSync(result.journalPath, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

function workspaceFile(run: TrialRun, name: string): string | null {
  const file = path.join(run.workspaceCwd, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

beforeEach(() => {
  previousSupervisorBinary = process.env.CORTEX_SUPERVISOR_BINARY;
  process.env.CORTEX_SUPERVISOR_BINARY = process.execPath;
  harness.attachOptions.length = 0;
  harness.unscopedRunAgent.mockClear();
  jobCtx.bus = null;
  fs.rmSync(snapshotParent, { recursive: true, force: true });
});

afterAll(async () => {
  if (previousSupervisorBinary === undefined) delete process.env.CORTEX_SUPERVISOR_BINARY;
  else process.env.CORTEX_SUPERVISOR_BINARY = previousSupervisorBinary;
  await Promise.all(harness.parentJournals.map(journal => journal.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const backend of ['claude', 'pi'] as const) {
  it(`runs exactly two reviewer-fix stages, both in the shared root, on backend=${backend}`, async () => {
    const run = prepareTrial(`two-stage-${backend}`, backend, [
      { text: 'implemented' },
      { text: `audited and fixed the one blocker. ${FIX_MARKER}` },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    // C4's "exactly 2" lives HERE, not in the step budget: the budget is 3 so that the loop can
    // end on a missing outgoing edge rather than on exhaustion, and what actually bounds the
    // stage set is the transition graph — one rule, and nothing leaves `benchmark-fixer:auditFix`.
    // Two stages, not four: this variant has no retry edge and no final audit.
    assert.equal(result.steps, 2);
    assert.equal(ranStep(run, 0), true);
    assert.equal(ranStep(run, 1), true);
    assert.equal(ranStep(run, 2), false);

    // BOTH placements are the one shared writable root — that is what makes this variant this
    // variant, and no snapshot tree is ever created for it at all.
    assert.deepEqual(harness.attachOptions.map(attach => attach.cwd), [
      run.workspaceCwd, run.workspaceCwd,
    ]);
    assert.equal(fs.existsSync(snapshotParent), false);

    // Nothing was appended for either step: a shared-writable role writes its own handoff, so the
    // coordinator's snapshot append never fires. The header would be the visible trace of one.
    assert.equal(artifactOf(result).includes('--- snapshot step '), false);

    // The fixer spoke the verdict and it is this variant's own literal, not the other's.
    assert.deepEqual(result.proposal, { kind: 'complete' });
    const fixerText = journalRecords(result)
      .filter(record => record.agent_slot === 'benchmark-fixer'
        && record.event?.type === 'assistant_text')
      .map(record => record.event.text);
    assert.deepEqual(fixerText, [`audited and fixed the one blocker. ${FIX_MARKER}`]);
    assert.equal(fixerText[0].includes(APPROVAL_MARKER), false);
  }, 60_000);
}

for (const backend of ['claude', 'pi'] as const) {
  it(`keeps the fixer's fix in the shared workspace after the run on backend=${backend}`, async () => {
    // The mirror of audit-retry's discard proof, and the property that separates the two variants:
    // there the reviewer's mutation is thrown away with its snapshot; here it must survive.
    const run = prepareTrial(`fix-survives-${backend}`, backend, [
      { text: 'implemented', writes: { 'solution.txt': 'coder attempt\n' } },
      {
        text: `fixed the off-by-one and verified it. ${FIX_MARKER}`,
        writes: {
          'solution.txt': 'fixed by the reviewer\n',
          'nested/added-by-fixer.txt': 'a file only the fixer created\n',
        },
      },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    assert.equal(result.steps, 2);
    // The fixer's own child process wrote these, in the cwd the lease armed for it. They are in
    // the shared root after the run, and the coder's earlier content is the one that was replaced.
    assert.equal(workspaceFile(run, 'solution.txt'), 'fixed by the reviewer\n');
    assert.equal(workspaceFile(run, 'nested/added-by-fixer.txt'), 'a file only the fixer created\n');
    // Nothing was discarded, because nothing was disposable: no snapshot root was ever made, and
    // the fixer's own process cwd was the shared root itself.
    assert.equal(fs.existsSync(snapshotParent), false);
    const fixerObservation = JSON.parse(
      fs.readFileSync(path.join(run.observations, 'step-1.json'), 'utf8'),
    );
    assert.equal(fs.realpathSync(fixerObservation.cwd), fs.realpathSync(run.workspaceCwd));
    assert.deepEqual(result.proposal, { kind: 'complete' });
  }, 60_000);
}

for (const backend of ['claude', 'pi'] as const) {
  it(`blocks reviewer-fix when the fixer withholds its verdict on backend=${backend}`, async () => {
    const run = prepareTrial(`unresolved-${backend}`, backend, [
      { text: 'implemented' },
      { text: 'one blocker remains open: the fixture still fails under an empty input' },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    assert.equal(result.steps, 2);
    assert.deepEqual(result.proposal, { kind: 'block', reason: 'verdict_marker_absent' });
  }, 60_000);
}

for (const backend of ['claude', 'pi'] as const) {
  it(`blocks reviewer-fix with an unavailable verdict when the fixer is silent on backend=${backend}`, async () => {
    // A final step that ends on a tool call emits no assistant message at all. The absence is a
    // different fact from a fixer that declined to approve, and it must not become an approval.
    const run = prepareTrial(`silent-${backend}`, backend, [
      { text: 'implemented' },
      { text: null, writes: { 'solution.txt': 'fixed but never spoken\n' } },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    assert.equal(result.steps, 2);
    assert.deepEqual(result.proposal, { kind: 'block', reason: 'verdict_text_unavailable' });
    // The silent step still ran and still wrote: the block is about the verdict, not the work.
    assert.equal(workspaceFile(run, 'solution.txt'), 'fixed but never spoken\n');
    const fixerText = journalRecords(result)
      .filter(record => record.agent_slot === 'benchmark-fixer'
        && record.event?.type === 'assistant_text');
    assert.deepEqual(fixerText, []);
  }, 60_000);
}

for (const backend of ['claude', 'pi'] as const) {
  it(`commits a terminal manifest that reads the fixer slot back on backend=${backend}`, async () => {
    // Widening only the orchestrator's admission set lets everything above pass and loses the run
    // here, at readback, on an otherwise green build.
    const run = prepareTrial(`readback-${backend}`, backend, [
      { text: 'implemented' },
      { text: `fixed. ${FIX_MARKER}` },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.manifestCommitted, true);
    assert.deepEqual(validateTrajectoryLifecycle({
      trajectoryRoot: run.trajectoryRoot, canonicalTrajectoryRoot: true,
      rootRunId: run.rootRunId, threadId: result.threadId,
    }), { ok: true, problems: [] });
    const slots = new Set(journalRecords(result).map(record => record.agent_slot));
    assert.equal(slots.has('benchmark-fixer'), true);

    // PI's own result shape carries no final output, so its summary is empty while the very same
    // proposal is complete. A decision that read the summary would refuse this run on PI alone.
    if (backend === 'pi') assert.equal(result.summary, '');
    else assert.ok(result.summary.includes(FIX_MARKER));
  }, 60_000);
}

it('admits no process reaching for git, a commit or the host task queue', async () => {
  // V-ARGV, the behavioural half of NI2/NI3/NI4/NI6: the vocabulary checks constrain a document,
  // this constrains what the run is actually allowed to start.
  const run = prepareTrial('argv-fence', 'claude', [
    { text: 'implemented' },
    { text: `fixed. ${FIX_MARKER}` },
  ]);

  const result = await runBenchmarkThread(run);

  assert.equal(result.state, 'completed');
  assert.equal(harness.attachOptions.length, 2);
  for (const attach of harness.attachOptions) {
    const [command, ...args] = attach.args;
    assert.notEqual(path.basename(command), 'git');
    assert.notEqual(path.basename(command), 'cortex-task');
    for (const argument of args) {
      assert.equal(argument === 'git' || argument.startsWith('git '), false, argument);
      assert.notEqual(argument, 'cortex-task');
      assert.equal(argument.includes('npm test'), false, argument);
    }
    assert.equal(Object.keys(attach.env ?? {}).includes('CORTEX_TASK_ID'), false);
  }
});

it('needs no trial root, because no reviewer-fix role runs in a disposable snapshot', async () => {
  const run = prepareTrial('no-trial-root', 'claude', [
    { text: 'implemented' },
    { text: `fixed. ${FIX_MARKER}` },
  ], { trialRoot: undefined });

  const result = await runBenchmarkThread(run);

  // The sibling variant refuses this request outright: its reviewer has nowhere to be placed.
  assert.equal(result.state, 'completed');
  assert.equal(result.steps, 2);
  assert.deepEqual(harness.attachOptions.map(attach => attach.cwd), [
    run.workspaceCwd, run.workspaceCwd,
  ]);
}, 60_000);

it('refuses a request whose variant disagrees with the compiled reviewer-fix arm', async () => {
  const run = prepareTrial('variant-conflict', 'claude', [
    { text: 'implemented' },
  ], { coderReviewVariant: 'audit-retry' });

  await assert.rejects(runBenchmarkThread(run), /variant/i);
  assert.equal(harness.attachOptions.length, 0);
});
