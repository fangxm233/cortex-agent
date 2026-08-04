// input:  a compiled coder-review policy per backend, the real orchestrator and real child CLIs
// output: per-step trial adapters, widened identity pins and both-backend parity
// pos:    Backend neutrality proof for the in-trial benchmark thread
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. The far side of every assertion is real: the real orchestrator, the real step loop,
// the real workspace lease and its spawner, the real trial adapter factory, the real backend
// adapter and a real child process per step. Only the model is a stand-in, and every terminal text
// it produces is named by the test body — no fixture supplies an invariant of its own, and one step
// deliberately produces no terminal text at all.

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
    // The far side of the process boundary: a real child, started in the cwd the lease armed and
    // with the environment the trial pinned.
    attachSupervisor: (options: any) => {
      harness.attachOptions.push({ cwd: options.cwd, args: options.args });
      const [command, ...args] = options.args;
      const child = spawn(command, args, {
        cwd: options.cwd, env: options.env, stdio: 'pipe',
      });
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

import { CONFIG_DIR, DATA_DIR } from '../../../src/core/paths.js';
import type { Backend } from '../../../src/agent-adapter/types.js';
import { openJournal } from '../../../src/domain/agent-run/journal.js';
import { writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';
import { preparePinnedTrialPaths } from '../../../src/domain/agent-run/pinned-node-process.js';
import {
  createBenchmarkTrialRunAgent,
} from '../../../src/domain/benchmark/trial-thread-adapter.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import { profileRepo } from '../../../src/store/profile-repo.js';
import {
  compileTrialPolicy, FIXTURE_MODEL, FIXTURE_PROFILE, writeFixtureAsset, writeTrialProfile,
  type TrialPolicyFixture,
} from '../benchmark/trial-thread-policy-fixture.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-neutral-'));
const snapshotParent = path.join(DATA_DIR, 'tmp', 'review-snapshot');
let previousSupervisorBinary: string | undefined;

interface StepScript {
  /** Terminal text this step's model produces; null → the step produces none at all. */
  text: string | null;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function benchmarkAgent(name: string): Record<string, unknown> {
  return {
    name, profile: '__active__', persistSession: false,
    directive: `${name} directive`, systemPrompt: `${name} template system`,
    promptTemplate: 'Complete {{input}}', tools: 'Bash', pluginDirs: [],
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
  fs.mkdirSync(path.join(base, 'shells'), { recursive: true });
}

/** A real backend-shaped child. Each invocation takes the next step script the test queued, so the
 *  terminal text is always the test's and never the fixture's. */
function writeFakeCli(label: string, backend: Backend, queue: string, observations: string): string {
  const take = `
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const queue = JSON.parse(fs.readFileSync(${JSON.stringify(queue)}, 'utf8'));
const index = queue.findIndex(entry => entry.taken !== true);
const step = queue[index];
step.taken = true;
fs.writeFileSync(${JSON.stringify(queue)}, JSON.stringify(queue));
fs.mkdirSync(${JSON.stringify(observations)}, { recursive: true });
fs.writeFileSync(path.join(${JSON.stringify(observations)}, \`step-\${index}.json\`), JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), env: process.env,
}));
function say(record) { process.stdout.write(\`\${JSON.stringify(record)}\\n\`); }
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
`;
  const body = backend === 'claude'
    ? `
lines.once('line', (line) => {
  const request = JSON.parse(line);
  if (step.text !== null) {
    say({ type: 'assistant', message: { id: 'a1', model: 'fixture-reported', content: [{ type: 'text', text: step.text }] } });
  }
  say({
    type: 'result', subtype: 'success', is_error: false,
    session_id: request.session_id ?? 'claude-trial-session',
    result: step.text ?? '', num_turns: 1,
  });
  setTimeout(() => process.exit(0), 10);
});
`
    : `
lines.on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.type === 'get_state') {
    say({ type: 'response', id: command.id, command: 'get_state', success: true, data: { sessionId: 'pi-trial-session' } });
    return;
  }
  if (command.type === 'get_session_stats') {
    say({ type: 'response', id: command.id, command: 'get_session_stats', success: true, data: { contextUsage: { contextWindow: 200000, tokens: 1024, percent: 0.5 } } });
    return;
  }
  if (command.type === 'prompt') {
    if (step.text !== null) {
      say({ type: 'message_update', message: { id: 'msg-1' }, assistantMessageEvent: { type: 'text_delta', delta: step.text } });
    }
    say({ type: 'agent_end', messages: [{ role: 'assistant', provider: 'anthropic', model: 'fixture-reported', usage: { input: 12, output: 4, cost: { total: 0 } } }] });
    say({ type: 'agent_settled' });
  }
});
lines.on('close', () => process.exit(0));
`;
  const script = writeFixtureAsset(root, `${label}/cli.mjs`, take + body);
  return writeFixtureAsset(
    root, `${label}/cli`,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    0o755,
  );
}

interface TrialRun {
  request: any;
  overrides: Record<string, unknown>;
  fixture: TrialPolicyFixture;
  trialHome: string;
  cli: string;
  observations: string;
  workspaceCwd: string;
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

function prepareTrial(label: string, backend: Backend, steps: StepScript[]): TrialRun {
  const queue = writeFixtureAsset(root, `${label}/queue.json`, JSON.stringify(steps));
  const observations = path.join(root, label, 'observations');
  const cli = writeFakeCli(label, backend, queue, observations);
  const fixture = compileTrialPolicy({ root: path.join(root, label), backend, cli, label });
  seedTemplates();
  const workspaceCwd = path.join(root, label, 'workspace');
  fs.mkdirSync(workspaceCwd, { recursive: true });
  fs.writeFileSync(path.join(workspaceCwd, 'solution.txt'), 'shared original\n');
  const trajectoryRoot = path.join(root, label, 'trajectory');
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  const rootRunId = `run-${label}`;
  seedParentLifecycle(trajectoryRoot, rootRunId, workspaceCwd, backend);
  const trialHome = path.join(root, label, 'trial-home');
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
        paths: preparePinnedTrialPaths(trialHome),
        supervisor: { binary: process.execPath, graceMs: 1_000 },
      }),
    },
    fixture, trialHome, cli, observations, workspaceCwd,
  };
}

async function runBenchmarkThread(value: any, overrides: Record<string, unknown>): Promise<any> {
  const api = await import('../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js');
  return api.runBenchmarkThread(value, overrides as any);
}

function observed(run: TrialRun, index: number): { argv: string[]; cwd: string; env: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(run.observations, `step-${index}.json`), 'utf8'));
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
  it(`runs an in-trial thread on backend=${backend} through one trial adapter per step`, async () => {
    // Step two produces no terminal text at all, so nothing downstream may depend on one.
    const run = prepareTrial(`neutral-${backend}`, backend, [{ text: 'coder done' }, { text: null }]);

    const result = await runBenchmarkThread(run.request, run.overrides);

    assert.equal(result.state, 'completed');
    assert.equal(result.steps, 2);
    // The unscoped daemon runAgent — the one an adapter registry would reach — never ran.
    assert.equal(harness.unscopedRunAgent.mock.calls.length, 0);

    // Every step spawned the trial's pinned CLI, never a CLI resolved from PATH.
    assert.equal(harness.attachOptions.length, 2);
    for (const attach of harness.attachOptions) assert.equal(attach.args[0], run.cli);

    // Each step ran in the workspace its own placement armed; a reused adapter would have carried
    // the first step's cwd into the second.
    const snapshot = path.join(snapshotParent, result.threadId, '1');
    assert.deepEqual(
      harness.attachOptions.map(attach => attach.cwd), [run.workspaceCwd, snapshot],
    );
    assert.equal(observed(run, 0).cwd, fs.realpathSync(run.workspaceCwd));
    assert.notEqual(observed(run, 1).cwd, observed(run, 0).cwd);

    // The pinned trial environment reached the child, so no host state was in scope.
    for (const index of [0, 1]) {
      assert.equal(observed(run, index).env.CORTEX_HOME, path.join(run.trialHome, 'cortex-home'));
    }
    // The snapshot was discarded at its own step boundary.
    assert.equal(fs.existsSync(snapshotParent), false);
  }, 60_000);
}

it('leaves the summary empty on a backend that reports no terminal output', async () => {
  const claude = prepareTrial('summary-claude', 'claude', [{ text: 'coder done' }, { text: 'reviewer verdict' }]);
  const pi = prepareTrial('summary-pi', 'pi', [{ text: 'coder done' }, { text: 'reviewer verdict' }]);

  writeTrialProfile('claude');
  const claudeResult = await runBenchmarkThread(claude.request, claude.overrides);
  harness.attachOptions.length = 0;
  writeTrialProfile('pi');
  const piResult = await runBenchmarkThread(pi.request, pi.overrides);

  assert.equal(claudeResult.state, 'completed');
  assert.equal(piResult.state, 'completed');
  // The Claude branch reports its terminal text; the PI branch reports none, whatever the model
  // said. Any cross-backend claim resting on the summary is a claim about the Claude fixture only.
  assert.equal(claudeResult.summary, 'reviewer verdict');
  assert.equal(piResult.summary, '');
}, 60_000);

it('refuses a profile whose backend is not the compiled arm\'s', async () => {
  const run = prepareTrial('wrong-backend', 'pi', [{ text: 'coder done' }, { text: null }]);
  // The profile the trial resolves is a Claude one while the compiled arm declares PI.
  writeJson(path.join(CONFIG_DIR, 'profiles.json'), {
    defaultProfile: FIXTURE_PROFILE,
    profiles: {
      [FIXTURE_PROFILE]: {
        model: FIXTURE_MODEL, backend: 'claude', mode: 'api', provider: 'anthropic',
        extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: 'high', fallback: [],
      },
    },
  });
  profileRepo.invalidate();

  await assert.rejects(runBenchmarkThread(run.request, run.overrides), /backend/i);
  assert.equal(harness.attachOptions.length, 0);
});

it('still refuses Claude outside print mode', async () => {
  const run = prepareTrial('tui-claude', 'claude', [{ text: 'coder done' }, { text: null }]);
  writeJson(path.join(CONFIG_DIR, 'profiles.json'), {
    defaultProfile: FIXTURE_PROFILE,
    profiles: {
      [FIXTURE_PROFILE]: {
        model: FIXTURE_MODEL, backend: 'claude', mode: 'api', provider: 'anthropic',
        extraEnv: {}, extraOption: {}, claudeBackend: 'tui', thinking: 'high', fallback: [],
      },
    },
  });
  profileRepo.invalidate();

  await assert.rejects(runBenchmarkThread(run.request, run.overrides), /print/i);
  assert.equal(harness.attachOptions.length, 0);
});

it('makes a mid-thread profile switch a typed protocol violation on a PI arm', async () => {
  const run = prepareTrial('mid-switch', 'pi', [{ text: 'coder done' }, { text: null }]);
  const runAgent = run.overrides.runAgent as (message: string, options: any) => any;
  let steps = 0;
  run.overrides.runAgent = (message: string, options: any) => {
    steps += 1;
    if (steps === 1) {
      // The profile drifts to the other backend between the first and the second step.
      writeJson(path.join(CONFIG_DIR, 'profiles.json'), {
        defaultProfile: FIXTURE_PROFILE,
        profiles: {
          [FIXTURE_PROFILE]: {
            model: FIXTURE_MODEL, backend: 'claude', mode: 'api', provider: 'anthropic',
            extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: 'high', fallback: [],
          },
        },
      });
      profileRepo.invalidate();
    }
    return runAgent(message, options);
  };

  const result = await runBenchmarkThread(run.request, run.overrides);

  assert.equal(result.state, 'failed');
  assert.equal(result.terminalReason, 'protocol_violation');
  // Only the first step ever reached a process.
  assert.equal(harness.attachOptions.length, 1);
}, 60_000);

it('refuses a benchmark run that would re-arm the unscoped lifecycle hook runner', async () => {
  const run = prepareTrial('hooks-refused', 'claude', [{ text: 'coder done' }, { text: null }]);

  await assert.rejects(
    runBenchmarkThread(run.request, { ...run.overrides, emitLifecycleHooks: async () => {} }),
    /lifecycle hook/i,
  );
  assert.equal(harness.attachOptions.length, 0);
});
