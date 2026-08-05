// input:  a compiled coder-review policy, the shipped thread documents and the real orchestrator
// output: which byte source the journal records for an in-trial step, and what refuses it
// pos:    Identity-of-record proof for the in-trial benchmark thread
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. The far side is real throughout: the real compiler produces the policy, the real
// template loader produces the projection, the real orchestrator freezes the identities and writes
// the journal, and a real child process runs each step. The refusal cases are proved by counting
// `attachSupervisor` calls on the real spawn path rather than by inspecting a return value.

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
import { resolveProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import { getTemplate } from '../../../src/domain/threads/template-loader.js';
import {
  freezeBenchmarkThreadIdentities,
} from '../../../src/domain/agent-run/benchmark-thread-identity.js';
import { canonicalJsonSha256, computeRoleToolSurfaceHash } from '../../../src/domain/agent-run/identity.js';
import { openJournal } from '../../../src/domain/agent-run/journal.js';
import { writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';
import { preparePinnedTrialPaths } from '../../../src/domain/agent-run/pinned-node-process.js';
import { compiledRoleSurface } from '../../../src/domain/benchmark/resolved-policy.js';
import {
  createBenchmarkTrialRunAgent,
} from '../../../src/domain/benchmark/trial-thread-adapter.js';
import { readActiveLeaseState } from '../../../src/domain/benchmark/workspace-lease.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import {
  compileTrialPolicy, FIXTURE_MODEL, FIXTURE_PROFILE, writeFixtureAsset,
  type TrialPolicyFixture,
} from '../benchmark/trial-thread-policy-fixture.js';
import { writeFakeBackendCli, type FakeStepScript } from './fake-backend-cli.js';
import { seedShippedPrompts } from './benchmark-shipped-prompts.js';

const SHIPPED = path.join(DEFAULTS_DIR, 'config', 'thread-templates');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-identity-'));
let previousSupervisorBinary: string | undefined;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function agentFile(slot: string): string {
  return path.join(CONFIG_DIR, 'thread-templates', 'agents', `${slot}.json`);
}

/** The shipped child documents, plus a two-step template so the run is short. The agents are the
 *  ones that ship because the projection is only worth checking against what production composes. */
function seedTemplates(): void {
  const base = path.join(CONFIG_DIR, 'thread-templates');
  for (const slot of ['benchmark-coder', 'benchmark-reviewer']) {
    fs.mkdirSync(path.dirname(agentFile(slot)), { recursive: true });
    fs.copyFileSync(path.join(SHIPPED, 'agents', `${slot}.json`), agentFile(slot));
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

/** Rewrite one member of a seeded template agent document — the projection's own source, and the
 *  only side a perturbation may touch: the compiled policy stays exactly as it was. */
function perturbAgentDocument(slot: string, mutate: (document: any) => void): void {
  const document = JSON.parse(fs.readFileSync(agentFile(slot), 'utf8'));
  mutate(document);
  writeJson(agentFile(slot), document);
}

interface TrialRun {
  request: any;
  overrides: Record<string, unknown>;
  fixture: TrialPolicyFixture;
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

function prepareTrial(label: string, backend: Backend, steps: FakeStepScript[]): TrialRun {
  const queue = writeFixtureAsset(root, `${label}/queue.json`, JSON.stringify(steps));
  const observations = path.join(root, label, 'observations');
  const cli = writeFakeBackendCli(root, label, backend, queue, observations);
  const fixture = compileTrialPolicy({ root: path.join(root, label), backend, cli, label });
  seedTemplates();
  const workspaceCwd = path.join(root, label, 'workspace');
  fs.mkdirSync(workspaceCwd, { recursive: true });
  const trajectoryRoot = path.join(root, label, 'trajectory');
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  const rootRunId = `run-${label}`;
  seedParentLifecycle(trajectoryRoot, rootRunId, workspaceCwd, backend);
  return {
    request: {
      workspaceCwd, template: 'fixture-two-step', instruction: 'fix the fixture',
      profileName: FIXTURE_PROFILE, rootRunId, trajectoryRoot, trialRoot: DATA_DIR,
      coderReviewVariant: 'audit-retry', trialPolicy: fixture.policy,
      limits: { maxSteps: 4, maxCostUsd: 1, deadlineEpochMs: Date.now() + 60_000 },
      signal: new AbortController().signal,
    },
    overrides: {
      runAgent: createBenchmarkTrialRunAgent({
        policy: fixture.policy, config: fixture.config,
        paths: preparePinnedTrialPaths(path.join(root, label, 'trial-home')),
        supervisor: { binary: process.execPath, graceMs: 1_000 },
        leaseState: readActiveLeaseState,
      }),
    },
    fixture,
  };
}

async function runBenchmarkThread(value: any, overrides: Record<string, unknown>): Promise<any> {
  const api = await import('../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js');
  return api.runBenchmarkThread(value, overrides as any);
}

function journalRecords(journalPath: string): any[] {
  return fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

/** The per-slot identity triple as the journal's own event records carry it. */
function journalIdentities(journalPath: string): Map<string, any> {
  const identities = new Map<string, any>();
  for (const event of journalRecords(journalPath)) {
    if (event.type !== 'event' || typeof event.role_tool_surface_hash !== 'string') continue;
    identities.set(event.agent_slot, event);
  }
  return identities;
}

const TWO_STEPS: FakeStepScript[] = [{ text: 'coder done' }, { text: 'reviewer verdict' }];

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

// --- ID1/ID2/ID7(i): the compiled policy role is the record, on both backends (ID3-NS (a)) ---

for (const backend of ['claude', 'pi'] as const) {
  it(`records the compiled policy role for every child slot on backend=${backend}`, async () => {
    const run = prepareTrial(`record-${backend}`, backend, TWO_STEPS);

    const result = await runBenchmarkThread(run.request, run.overrides);

    assert.equal(result.state, 'completed', String(result.terminalReason ?? result.error));
    assert.equal(result.steps, 2);
    const identities = journalIdentities(result.journalPath);
    assert.deepEqual([...identities.keys()].sort(), ['benchmark-coder', 'benchmark-reviewer']);
    const policy = run.fixture.policy;
    for (const [slot, event] of identities) {
      const surface = compiledRoleSurface(policy, slot)!;
      assert.ok(surface, `no compiled surface for ${slot}`);
      // ID7(i): byte-for-byte the compiled policy's own per-slot hash.
      assert.equal(event.role_tool_surface_hash, policy.identity.role_tool_surface_hash[slot]);
      // ID2: the bundle hash comes from the same side, and it is the arm's single one.
      assert.equal(event.bundle_manifest_hash, policy.identity.bundle_manifest_hash);
      // The projection is not the record: it omits the guard, so its hash cannot be this one.
      assert.notEqual(
        event.role_tool_surface_hash,
        computeRoleToolSurfaceHash({ ...surface, benchmarkPolicyGuard: undefined }),
      );
    }
    // ID2 again on the three fields only the header carries, for the slot that opened it.
    const header = journalRecords(result.journalPath)[0];
    const entry = compiledRoleSurface(policy, header.agent_slot)!;
    assert.equal(header.system_prompt_sha256, entry.systemPromptSha256);
    assert.equal(header.tool_manifest_sha256, canonicalJsonSha256(entry.tools));
    assert.equal(header.plugin_manifest_sha256, canonicalJsonSha256({
      plugin_dirs: entry.pluginDirs, skills: entry.skills,
    }));
  }, 60_000);
}

// --- ID7(ii): the template perturbation refuses before any spawn, on both backends (ID3-NS (b)) ---

for (const backend of ['claude', 'pi'] as const) {
  it(`refuses before any spawn when the template agent's tools drift on backend=${backend}`, async () => {
    const run = prepareTrial(`drift-${backend}`, backend, TWO_STEPS);
    // One name added to the projection's side only; the compiled policy is untouched.
    perturbAgentDocument('benchmark-reviewer', (document) => {
      document.tools = `${document.tools},Write`;
    });

    const result = await runBenchmarkThread(run.request, run.overrides);

    assert.equal(result.state, 'failed');
    assert.equal(result.terminalReason, 'protocol_violation');
    assert.equal(harness.attachOptions.length, 0, 'a process was spawned before the refusal');
  }, 60_000);
}

it('names the slot and the diverging member in the refusal', async () => {
  const run = prepareTrial('drift-named', 'claude', TWO_STEPS);
  perturbAgentDocument('benchmark-coder', (document) => {
    document.tools = 'Bash,Read,Write,Edit,Glob,Grep,Skill,TodoWrite';
  });

  const result = await runBenchmarkThread(run.request, run.overrides);

  assert.equal(result.state, 'failed');
  assert.match(String(result.terminalReason), /protocol_violation/);
  assert.equal(harness.attachOptions.length, 0);
  // The reason the run refuses on, read where it is produced: the terminal manifest keeps only the
  // taxonomy code, so an operator's only account of WHICH role diverged is this string.
  const identities = freezeBenchmarkThreadIdentities(
    run.request, resolveProfileConfig(FIXTURE_PROFILE), getTemplate(run.request.template),
    'claude', run.fixture.policy,
  );
  assert.match(String(identities.roleIdentityProblem), /benchmark-coder/);
  assert.match(String(identities.roleIdentityProblem), /tools/);
}, 60_000);

// --- ID3-NS (c): the null branch is exercised on both sides ---

it('refuses a projected tool that has no image in the arm backend', async () => {
  // `Agent` is canonical `agent`, which PI answers to through its shim and therefore has no entry
  // in the PI name map: `fromCanonical('pi', 'agent')` is null. A predicate that skipped the null
  // would compare `null === null` and pass two names that are not the same tool.
  const run = prepareTrial('null-image', 'pi', TWO_STEPS);
  perturbAgentDocument('benchmark-reviewer', (document) => {
    document.tools = 'Bash,Read,Glob,Grep,TodoWrite,Agent';
  });

  const result = await runBenchmarkThread(run.request, run.overrides);

  assert.equal(result.state, 'failed');
  assert.equal(harness.attachOptions.length, 0);
}, 60_000);

it('refuses a projected tool name the Claude namespace does not know', async () => {
  const run = prepareTrial('null-canonical', 'claude', TWO_STEPS);
  perturbAgentDocument('benchmark-reviewer', (document) => {
    document.tools = 'Bash,Read,Glob,Grep,TodoWrite,NotATool';
  });

  const result = await runBenchmarkThread(run.request, run.overrides);

  assert.equal(result.state, 'failed');
  assert.equal(harness.attachOptions.length, 0);
}, 60_000);

// --- ID5: the one-sided `resolveSystemVars` is not normalised away ---

it('refuses a benchmark role whose projected prompt carries a system variable', async () => {
  const run = prepareTrial('system-var', 'claude', TWO_STEPS);
  // The projection resolves `{{date}}`; the compiler hashes the file bytes. A check that resolved
  // both sides, or neither, would call these two different prompts the same role.
  perturbAgentDocument('benchmark-reviewer', (document) => {
    document.systemPrompt = 'Audit the change on {{date}}.';
  });

  const result = await runBenchmarkThread(run.request, run.overrides);

  assert.equal(result.state, 'failed');
  assert.equal(harness.attachOptions.length, 0);
}, 60_000);

// --- ID6/ID7(iii): with no policy the projection stays the record ---

it('leaves the projection as the record when the request carries no trial policy', async () => {
  const withPolicy = prepareTrial('no-policy', 'claude', TWO_STEPS);
  const policy = withPolicy.fixture.policy;
  const request = { ...withPolicy.request, trialPolicy: undefined };

  const result = await runBenchmarkThread(request, withPolicy.overrides);

  assert.equal(result.state, 'completed');
  const identities = journalIdentities(result.journalPath);
  assert.equal(identities.size, 2);
  for (const [slot, event] of identities) {
    // Not the compiled policy's hash — the projection's, exactly as before this change.
    assert.notEqual(event.role_tool_surface_hash, policy.identity.role_tool_surface_hash[slot]);
    assert.notEqual(event.bundle_manifest_hash, policy.identity.bundle_manifest_hash);
  }
}, 60_000);

// --- The projection helper is the compiler's own bytes, not a restatement of them ---

it('reconstructs exactly the surface the compiler hashed for each slot', () => {
  const fixture = compileTrialPolicy({
    root: path.join(root, 'projection'), backend: 'claude',
    cli: writeFixtureAsset(root, 'projection/cli', '#!/bin/sh\nexit 0\n', 0o755),
    label: 'projection',
  });

  for (const slot of Object.keys(fixture.policy.roles)) {
    const surface = compiledRoleSurface(fixture.policy, slot);
    assert.ok(surface, `no compiled surface for ${slot}`);
    assert.equal(
      computeRoleToolSurfaceHash({
        ...surface!, benchmarkPolicyGuard: fixture.policy.role_policy_guard[slot],
      }),
      fixture.policy.identity.role_tool_surface_hash[slot],
    );
  }
});
