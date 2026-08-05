// input:  the shipped four-stage audit-retry template, a compiled arm and real child CLIs
// output: this variant's own stage count, placement, convergence rule and proposal decision
// pos:    Audit-retry variant path proof for the in-trial benchmark thread
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. Nothing here is shared with the other variant: the template is the shipped
// `benchmark-coder-review` document with its own four stages, and every placement assertion names
// the coder-shared / reviewer-snapshot alternation that only this variant has. The far side of
// every seam is real — the real orchestrator, the real step loop, the real lease and its spawner,
// the real trial adapter, the real backend adapter and one real child process per step. The only
// stand-in is the model, and every assistant message it emits is named by the test that queued it.

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  attachOptions: [] as { cwd?: string; args: string[] }[],
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
      harness.attachOptions.push({ cwd: options.cwd, args: options.args });
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
import { writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';
import { preparePinnedTrialPaths } from '../../../src/domain/agent-run/pinned-node-process.js';
import { createBenchmarkTrialRunAgent } from '../../../src/domain/benchmark/trial-thread-adapter.js';
import { readActiveLeaseState } from '../../../src/domain/benchmark/workspace-lease.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import {
  compileTrialPolicy, FIXTURE_MODEL, FIXTURE_PROFILE, writeFixtureAsset,
} from '../benchmark/trial-thread-policy-fixture.js';
import { writeFakeBackendCli, type FakeStepScript } from './fake-backend-cli.js';
import { seedShippedPrompts } from './benchmark-shipped-prompts.js';

const SHIPPED = path.join(DEFAULTS_DIR, 'config', 'thread-templates');
const TEMPLATE = 'benchmark-coder-review';
const APPROVAL_MARKER = '[IMPL-APPROVED]';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-audit-retry-'));
const snapshotParent = path.join(DATA_DIR, 'tmp', 'review-snapshot');
let previousSupervisorBinary: string | undefined;

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The shipped documents themselves, so the four stages under test are the ones that ship. */
function seedShippedDocuments(): void {
  const base = path.join(CONFIG_DIR, 'thread-templates');
  for (const [kind, name] of [
    ['agents', 'benchmark-coder'], ['agents', 'benchmark-reviewer'], ['templates', TEMPLATE],
  ] as const) {
    const target = path.join(base, kind, `${name}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SHIPPED, kind, `${name}.json`), target);
  }
  fs.mkdirSync(path.join(base, 'shells'), { recursive: true });
  seedShippedPrompts();
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
}

function prepareTrial(
  label: string, backend: Backend, steps: FakeStepScript[],
  overrides: Record<string, unknown> = {},
): TrialRun {
  const queue = writeFixtureAsset(root, `${label}/queue.json`, JSON.stringify(steps));
  const observations = path.join(root, label, 'observations');
  const cli = writeFakeBackendCli(root, label, backend, queue, observations);
  const fixture = compileTrialPolicy({ root: path.join(root, label), backend, cli, label });
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
      coderReviewVariant: 'audit-retry', trialPolicy: fixture.policy,
      limits: { maxSteps: 4, maxCostUsd: 1, deadlineEpochMs: Date.now() + 60_000 },
      signal: new AbortController().signal, ...overrides,
    },
    overrides: {
      runAgent: createBenchmarkTrialRunAgent({
        policy: fixture.policy, config: fixture.config,
        paths: preparePinnedTrialPaths(path.join(root, label, 'trial-home')),
        supervisor: { binary: process.execPath, graceMs: 1_000 },
        leaseState: readActiveLeaseState,
      }),
    },
    observations, workspaceCwd,
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

function headerLines(artifact: string): string[] {
  return artifact.split('\n').filter(line => line.startsWith('--- snapshot step '));
}

/** The reviewer's assistant messages as the journal recorded them, in order. */
function journalAssistantText(result: any, slot: string): string[] {
  return fs.readFileSync(result.journalPath, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(record => record.agent_slot === slot && record.event?.type === 'assistant_text')
    .map(record => record.event.text);
}

function snapshotAt(result: any, stepIndex: number): string {
  return path.join(snapshotParent, result.threadId, String(stepIndex));
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
  it(`runs all four audit-retry stages with its own placement on backend=${backend}`, async () => {
    const run = prepareTrial(`four-stage-${backend}`, backend, [
      { text: 'implemented' },
      { text: 'audit: one blocker remains' },
      { text: 'retried' },
      { text: 'final audit: the blocker still stands' },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    // Four stages, not two: this variant retries, and its final audit is a fourth step.
    assert.equal(result.steps, 4);
    for (const index of [0, 1, 2, 3]) assert.equal(ranStep(run, index), true, `step ${index}`);
    assert.equal(ranStep(run, 4), false);

    // The alternation IS the variant: the coder writes the shared workspace, the reviewer is
    // placed in a disposable snapshot of it, twice.
    assert.deepEqual(harness.attachOptions.map(attach => attach.cwd), [
      run.workspaceCwd, snapshotAt(result, 1), run.workspaceCwd, snapshotAt(result, 3),
    ]);
    assert.equal(fs.existsSync(snapshotParent), false);

    // Both reviewer stages were appended for by name, and neither coder step was.
    const headers = headerLines(artifactOf(result));
    assert.equal(headers.length, 2);
    assert.ok(headers[0].includes('benchmark-reviewer') && headers[0].includes('audit'));
    assert.ok(headers[1].includes('benchmark-reviewer') && headers[1].includes('finalAudit'));

    // No approval was ever spoken, so the pipeline proposes a block naming the missing verdict.
    assert.deepEqual(result.proposal, { kind: 'block', reason: 'verdict_marker_absent' });
  }, 60_000);
}

for (const backend of ['claude', 'pi'] as const) {
  it(`converges audit-retry on the reviewer's final message on backend=${backend}`, async () => {
    const run = prepareTrial(`converge-${backend}`, backend, [
      { text: 'implemented' },
      { text: `audit: the change is correct. ${APPROVAL_MARKER}` },
      { text: 'retried' },
      { text: 'final audit' },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    // Two of the four stages ran: the retry was never scheduled.
    assert.equal(result.steps, 2);
    assert.equal(ranStep(run, 2), false);
    assert.ok(artifactOf(result).includes(APPROVAL_MARKER));
    assert.equal(result.proposal.kind, 'complete');

    // The verdict the decision used is the journal's own assistant message, not the artifact file
    // and not the thread summary — which one of these two backends never populates at all.
    assert.deepEqual(journalAssistantText(result, 'benchmark-reviewer'), [
      `audit: the change is correct. ${APPROVAL_MARKER}`,
    ]);
    // PI's own result shape carries no final output, so its summary is empty while the very same
    // proposal is complete. A decision that read the summary would refuse this run on PI alone.
    if (backend === 'pi') assert.equal(result.summary, '');
  }, 60_000);
}

for (const backend of ['claude', 'pi'] as const) {
  it(`refuses to converge on a marker outside the reviewer's final message on backend=${backend}`, async () => {
    // The reviewer writes a long audit that quotes the approval token while discussing it, then
    // ends on a terse verdict that withholds it. Only the final message is appended, so the
    // buried token must never reach the buffer the transition engine scans.
    const buried = `considered ending with ${APPROVAL_MARKER}, but three blockers remain. `.repeat(6);
    const run = prepareTrial(`buried-${backend}`, backend, [
      { text: 'implemented' },
      { lead: buried, text: 'audit: blockers remain' },
      { text: 'retried' },
      { text: 'final audit: blockers remain' },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    // It did not converge: the retry and the final audit both ran.
    assert.equal(result.steps, 4);
    assert.equal(ranStep(run, 2), true);
    assert.equal(ranStep(run, 3), true);
    const artifact = artifactOf(result);
    assert.equal(artifact.includes(APPROVAL_MARKER), false, artifact);
    assert.equal(artifact.includes(buried), false);
    assert.deepEqual(result.proposal, { kind: 'block', reason: 'verdict_marker_absent' });
  }, 60_000);
}

for (const backend of ['claude', 'pi'] as const) {
  it(`blocks with an unavailable verdict when the final audit is silent on backend=${backend}`, async () => {
    // A step that ends on a tool call emits no assistant message at all. The absence is a fact
    // about the run and must not be reported as a reviewer that declined to approve.
    const run = prepareTrial(`silent-verdict-${backend}`, backend, [
      { text: 'implemented' },
      { text: 'audit: one blocker remains' },
      { text: 'retried' },
      { text: null },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    assert.equal(result.steps, 4);
    assert.deepEqual(result.proposal, { kind: 'block', reason: 'verdict_text_unavailable' });
    // Nothing was appended for the silent step, so the artifact carries only the first audit.
    assert.equal(headerLines(artifactOf(result)).length, 1);
    assert.deepEqual(journalAssistantText(result, 'benchmark-reviewer'), [
      'audit: one blocker remains',
    ]);
  }, 60_000);
}

for (const backend of ['claude', 'pi'] as const) {
  it(`blocks an approval that only arrived once the step budget was spent on backend=${backend}`, async () => {
    // The final audit approves, but the loop stopped because the template's four stages were
    // used up rather than because the pipeline converged. That is not an approval to propose on.
    const run = prepareTrial(`late-approval-${backend}`, backend, [
      { text: 'implemented' },
      { text: 'audit: one blocker remains' },
      { text: 'retried' },
      { text: `final audit: fixed. ${APPROVAL_MARKER}` },
    ]);

    const result = await runBenchmarkThread(run);

    assert.equal(result.state, 'completed');
    assert.equal(result.steps, 4);
    assert.ok(artifactOf(result).includes(APPROVAL_MARKER));
    assert.deepEqual(result.proposal, { kind: 'block', reason: 'iterations_exhausted' });
  }, 60_000);
}

it('takes the variant from the compiled arm when the request names none', async () => {
  const run = prepareTrial('variant-from-arm', 'claude', [
    { text: 'implemented' },
    { text: `audit: correct. ${APPROVAL_MARKER}` },
  ], { coderReviewVariant: undefined });

  const result = await runBenchmarkThread(run);

  assert.equal(result.state, 'completed');
  // The arm's own variant placed the reviewer in a snapshot, and its own table decided the verdict.
  assert.deepEqual(harness.attachOptions.map(attach => attach.cwd), [
    run.workspaceCwd, snapshotAt(result, 1),
  ]);
  assert.equal(result.proposal.kind, 'complete');
}, 60_000);

it('refuses a request whose variant disagrees with the compiled arm', async () => {
  const run = prepareTrial('variant-conflict', 'claude', [
    { text: 'implemented' },
  ], { coderReviewVariant: 'reviewer-fix' });

  await assert.rejects(runBenchmarkThread(run), /variant/i);
  // The disagreement is caught before any model process exists.
  assert.equal(harness.attachOptions.length, 0);
});
