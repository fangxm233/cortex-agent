// input:  standalone guards and durable production attempts
// output: refusal guards and 19 production evidence cases
// pos:    Claude run guards and production v2 boundary matrix
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeAll, beforeEach, it, vi } from 'vitest';
import { loadAgentRunConfigWithPolicy } from '../../../src/domain/agent-run/run-config.js';
import {
  deriveSubagentLinks, runOneShotAgent, type AgentRunIo,
} from '../../../src/domain/agent-run/runner.js';
import type { AgentRunCliOptions } from '../../../src/domain/agent-run/agent-run-cli.js';
import type { ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import { profileRepo } from '../../../src/store/profile-repo.js';
import type {
  AttemptEdge, AttemptRecord,
} from '../../../src/domain/benchmark/attempt-record.js';
import {
  writeStartedMarker, writeTerminalManifest,
} from '../../../src/domain/agent-run/manifest.js';
import { createHash } from 'node:crypto';
import { BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';
import {
  withPublishedProductionBoundary, type ProductionBoundaryScenario,
  type PublishedProductionBoundary,
} from './production-evidence-boundary-fixture.js';

const installRoot = fileURLToPath(new URL('../../../', import.meta.url));
const supervisorBinary = path.join(installRoot, 'native/cortex-supervisor/dist/cortex-supervisor');
const CLI_VERSION = 'fixture-claude/9.9.9';
const ROOT_RUN_ID = 'trial-001.cortex-direct';

let root = '';
/** Overridden only by the lease-echo test, which needs a listener that answers the control route. */
let proxyBaseUrl = 'http://127.0.0.1:49152';

beforeAll(() => {
  const built = spawnSync('flock', [
    '-x', '/tmp/cortex-supervisor-build.lock', 'npm', 'run', 'build:supervisor',
  ], { cwd: installRoot, encoding: 'utf8' });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
}, 120_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-run-'));
  proxyBaseUrl = 'http://127.0.0.1:49152';
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface BackendBehaviour {
  /** Never answer, so the supervisor's deadline or cancel path is the only way out. */
  hang?: boolean;
  /** Fork a long-lived grandchild that records its own pid before sleeping. */
  grandchildPidFile?: string;
  /** Report provider usage, so the session's resolved context window becomes observable. */
  reportUsage?: boolean;
  /**
   * Emit a NATIVE subagent tool call and no `subagent_activity` attesting it — the OC-11
   * invisibility case. `name` is `Agent` or `Task`: the CLI declares both for one tool, so a census
   * keyed on `Agent` alone passes vacuously on the alias (G4-SA12).
   */
  nativeSubagentCall?: { id: string; name: string };
  /**
   * Report BOTH usage and a turn cost, so the adapter emits a complete `cost_record`. §9.6 A5
   * forbids the merge from treating a missing counter as zero, so without this the trajectory merge
   * correctly refuses with `aggregate_metrics_underivable` and F8 publishes no tree.
   */
  accounted?: boolean;
  /**
   * Emit the `thread_run` tool call — and its successful result — that a parent which admitted a
   * pipeline thread really makes. §9.3 M1's link map is keyed on that call id, so a seeded child
   * with no call in the parent's journal is a shape production cannot produce.
   */
  threadRunCall?: { id: string; threadId: string };
}

interface Fixture {
  options: AgentRunCliOptions;
  policy: ResolvedTrialPolicy;
  trialRoot: string;
  observation: string;
  workspace: string;
}

function write(file: string, content: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

/** A real backend process: it records the environment and argv it was actually given, writes into
 *  its own `$HOME`, and speaks just enough stream-json for one turn. Behaviour is baked into the
 *  source because the pinned trial environment carries no test variables into the child. */
function writeBackendCli(file: string, observation: string, behaviour: BackendBehaviour): string {
  const script = path.join(root, 'bundle', 'claude-trial.mjs');
  write(script, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
  env: process.env, argv: process.argv.slice(2),
  pid: process.pid, ppid: process.ppid, cwd: process.cwd(),
}));
fs.writeFileSync(process.env.HOME + '/backend-wrote-here', 'trial');
${behaviour.grandchildPidFile
    ? `spawn('/bin/sh', ['-c', 'echo $$ > ${JSON.stringify(behaviour.grandchildPidFile)}; sleep 30'], { stdio: 'ignore' }).unref();`
    : ''}
${behaviour.hang
    ? 'setInterval(() => {}, 1000);'
    : `const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once('line', (line) => {
  const request = JSON.parse(line);
${behaviour.reportUsage || behaviour.accounted
    ? `  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-reported-trial', usage: { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } }));`
    : ''}
${behaviour.nativeSubagentCall
    ? `  console.log(JSON.stringify({ type: 'assistant', message: { id: 'a0', model: 'claude-reported-trial', content: [{ type: 'tool_use', id: ${JSON.stringify(behaviour.nativeSubagentCall.id)}, name: ${JSON.stringify(behaviour.nativeSubagentCall.name)}, input: {} }] } }));`
    : ''}
${behaviour.threadRunCall
    ? `  console.log(JSON.stringify({ type: 'assistant', message: { id: 'a2', model: 'claude-reported-trial', content: [{ type: 'tool_use', id: ${JSON.stringify(behaviour.threadRunCall.id)}, name: 'thread_run', input: { action: 'start' } }] } }));
  console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: ${JSON.stringify(behaviour.threadRunCall.id)}, is_error: false, content: ${JSON.stringify(JSON.stringify({ thread_id: behaviour.threadRunCall.threadId, state: 'completed' }))} }] } }));`
    : ''}
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'a1', model: 'claude-reported-trial', content: [{ type: 'text', text: 'trial reply' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: request.session_id, result: 'trial reply', num_turns: 1${behaviour.accounted ? ", total_cost_usd: 0.0025, usage: { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }" : ''} }));
  lines.close();
});`}
`);
  return write(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, 0o755);
}

/** The fake supervisor selects its lifecycle mode from the environment, and the pinned trial
 *  environment carries no test variables, so the mode is baked into the launcher. */
function installFakeSupervisor(mode: string): string {
  const compiled = path.join(root, 'bin', 'fake-supervisor.mjs');
  write(compiled, ts.transpileModule(
    fs.readFileSync(fileURLToPath(new URL('./fake-supervisor.ts', import.meta.url)), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText);
  return write(
    path.join(root, 'bin', 'cortex-supervisor'),
    `#!/bin/sh\nFAKE_SUPERVISOR_MODE=${mode} exec ${JSON.stringify(process.execPath)} `
    + `${JSON.stringify(compiled)} "$@"\n`,
    0o755,
  );
}

function writeProfile(): void {
  write(path.join(process.env.CORTEX_HOME as string, 'config', 'profiles.json'), JSON.stringify({
    defaultProfile: 'benchmark-profile',
    profiles: {
      'benchmark-profile': {
        model: 'claude-sonnet', backend: 'claude', provider: 'anthropic',
        extraEnv: {}, extraOption: {}, claudeBackend: 'print', fallback: [],
      },
    },
  }));
  profileRepo.invalidate();
}

type ArmMode = 'direct' | 'coder-review';

function armResolution(cli: string, mode: ArmMode = 'direct'): Record<string, unknown> {
  const coderReview = mode === 'coder-review';
  // §1.3 rule 7 keeps BOTH task limits at 0 for every non-manager mode, and `arm-schema.ts`
  // requires `max_thread_starts` to be exactly 1 for coder-review and 0 otherwise.
  const parentRole = {
    system_prompt_path: write(path.join(root, 'parent-system.txt'), 'You are the benchmark parent.\n'),
    directive_path: write(path.join(root, 'parent-directive.txt'), 'Solve the task.\n'),
    tools: ['Read', 'Write'],
    plugin_dirs: [],
    mcp_composition: 'none',
    mcp_config_paths: [write(path.join(root, 'mcp-empty.json'), '{"mcpServers":{}}\n')],
    disable_hooks: true,
  };
  const templateDir = path.join(installRoot, 'defaults/config/thread-templates');
  return {
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: {
      schema_version: 'cortex-benchmark-arm/2',
      kind: 'cortex', name: 'cortex-direct', backend: 'claude', provider: 'anthropic',
      model: 'claude-sonnet', credential_capability: 'claude-api-key',
      orchestration: coderReview
        ? { mode: 'coder-review', coder_review_variant: 'audit-retry', ask_manager: false }
        : { mode: 'direct', ask_manager: false },
      limits: {
        max_thread_starts: coderReview ? 1 : 0,
        max_parent_questions: 0, max_task_depth: 0, max_tasks: 0,
        max_provider_requests: 8, max_resident_agent_processes: 3, max_cost_usd: '2.50',
        deadline_seconds: 90, max_output_tokens: 4096,
      },
    },
    arm_path: '/harness/arms/cortex-direct.yaml',
    trial_id: 'trial-001',
    root_run_id: ROOT_RUN_ID,
    task: {
      task_id: 'terminal-task', image_ref: 'registry.invalid/task@sha256:fixture',
      image_digest: `sha256:${'a'.repeat(64)}`,
    },
    profile_name: 'benchmark-profile',
    paid_run: false,
    credential_capabilities: [{
      id: 'claude-api-key', state: 'offline-contract-passed',
      key: {
        runner_or_backend: 'claude', provider: 'anthropic', protocol: 'anthropic-messages',
        credential_kind: 'api-key-bearer', proxy_adapter_version: 'cortex-bench-trial-proxy/2',
      },
    }],
    credential: {
      upstream_base_url: 'https://api.anthropic.com',
      route_identity_host: 'api.anthropic.com',
      proxy_base_url: proxyBaseUrl,
      dummy_token_ref: 'trial-token-handle',
    },
    cli_artifact: { path: cli, version: CLI_VERSION },
    model_alias_policy: { kind: 'exact' },
    roles: coderReview
      ? {
          parent: parentRole,
          // The role-slot vocabulary is CLOSED; these are the two the template names.
          'benchmark-coder': structuredClone(parentRole),
          'benchmark-reviewer': structuredClone(parentRole),
        }
      : { parent: parentRole },
    thread_templates: coderReview
      ? {
          'benchmark-coder-review':
            path.join(templateDir, 'templates/benchmark-coder-review.json'),
        }
      : {},
    thread_agents: coderReview
      ? {
          'benchmark-coder': path.join(templateDir, 'agents/benchmark-coder.json'),
          'benchmark-reviewer': path.join(templateDir, 'agents/benchmark-reviewer.json'),
        }
      : {},
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
}

function fixture(
  behaviour: BackendBehaviour = {}, deadlineMs?: number, mode: ArmMode = 'direct',
): Fixture {
  writeProfile();
  const observation = path.join(root, 'backend-observation.json');
  const cli = writeBackendCli(path.join(root, 'bundle', 'claude-trial'), observation, behaviour);
  const runConfigFile = write(
    path.join(root, 'arm-resolution.json'), JSON.stringify(armResolution(cli, mode)),
  );
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const agentDir = path.join(root, 'agent');
  const options: AgentRunCliOptions = {
    promptFile: write(path.join(root, 'prompt.txt'), 'finish the trial\n'),
    agentSlot: 'parent',
    profile: 'benchmark-profile',
    cwd: workspace,
    outputFormat: 'jsonl',
    eventsFile: path.join(agentDir, 'trajectory', 'events.jsonl'),
    trajectoryRoot: path.join(agentDir, 'trajectory'),
    runConfigFile,
    supervisorBinary,
    deadlineMs,
    graceMs: 200,
    rootRunId: ROOT_RUN_ID,
  };
  fs.mkdirSync(options.trajectoryRoot, { recursive: true });
  const policy = loadAgentRunConfigWithPolicy({ runConfigFile, agentSlot: 'parent' }).policy!;
  return { options, policy, trialRoot: path.join(agentDir, 'trial-home'), observation, workspace };
}

interface RunOutcome {
  exitCode: number;
  stdout: Record<string, any>[];
  stderr: string;
  terminal: Record<string, any>;
}

function collectingIo(lines: string[], errors: string[]): AgentRunIo {
  return {
    stdout: { write: (chunk: string) => { lines.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { errors.push(chunk); return true; } },
  };
}

async function runTrial(built: Fixture): Promise<RunOutcome> {
  const lines: string[] = [];
  const errors: string[] = [];
  const exitCode = await runOneShotAgent(built.options, collectingIo(lines, errors));
  const stdout = lines.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { exitCode, stdout, stderr: errors.join(''), terminal: stdout.at(-1)! };
}

// --- T1: the backend process is a child of the supervisor session ---

// --- T3: quiescence covers descendants the backend leaves behind ---

it('classifies a supervisor that never proves quiescence as a containment failure (T3)', async () => {
  const built = fixture();
  built.options.supervisorBinary = installFakeSupervisor('no-quiescent');
  const outcome = await runTrial(built);
  assert.equal(outcome.terminal.state, 'failed');
  assert.equal(outcome.terminal.terminal_reason, 'containment_failure');
  assert.equal(outcome.terminal.manifest, null);
  assert.notEqual(outcome.exitCode, 0);
}, 60_000);

// --- T4: cancellation parity ---

// --- T5: deadline parity ---

it('classifies a trial that outlives its deadline as a timeout (T5)', async () => {
  const built = fixture({ hang: true }, 700);
  const outcome = await runTrial(built);
  assert.equal(outcome.exitCode, 124, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'timeout');
  assert.equal(outcome.terminal.terminal_reason, 'deadline');
  assert.equal(fs.existsSync(path.join(
    built.options.trajectoryRoot, 'composite-manifest.json',
  )), false, 'a timed-out run must not admit the grader');
}, 60_000);

// --- T11: trial-local state ---

async function preAdmissionListener(action: () => void): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      action();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true, lease_state: 'reconciled', armed_remaining_ms: 60_000,
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

it('refuses a physically replaced state root before backend admission', async () => {
  let built!: Fixture;
  const outside = path.join(root, 'outside-state');
  const original = path.join(root, 'original-state');
  fs.mkdirSync(outside);
  const listener = await preAdmissionListener(() => {
    const state = path.join(built.trialRoot, 'cortex-home', 'state');
    fs.renameSync(state, original);
    fs.symlinkSync(outside, state);
  });
  proxyBaseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  built = fixture();
  let outcome: RunOutcome;
  try { outcome = await runTrial(built); }
  finally { await closeServer(listener); }

  assert.equal(outcome.exitCode, 125, outcome.stderr);
  assert.equal(outcome.terminal.terminal_reason, 'containment_failure');
  assert.equal(outcome.terminal.manifest, null);
  assert.equal(fs.existsSync(built.observation), false);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(
    built.options.trajectoryRoot, 'composite-manifest.json',
  )), false);
}, 60_000);

it('refuses a physically replaced workspace before backend admission', async () => {
  let built!: Fixture;
  const outside = path.join(root, 'outside-workspace');
  const original = path.join(root, 'original-workspace');
  fs.mkdirSync(outside);
  const listener = await preAdmissionListener(() => {
    fs.renameSync(built.workspace, original);
    fs.symlinkSync(outside, built.workspace);
  });
  proxyBaseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  built = fixture();
  let outcome: RunOutcome;
  try { outcome = await runTrial(built); }
  finally { await closeServer(listener); }

  assert.equal(outcome.exitCode, 125, outcome.stderr);
  assert.equal(outcome.terminal.terminal_reason, 'containment_failure');
  assert.equal(outcome.terminal.manifest, null);
  assert.equal(fs.existsSync(built.observation), false);
  assert.deepEqual(fs.readdirSync(outside), []);
}, 60_000);

// --- A15: stale trial settings fail before Claude can consume them ---

it('rejects stale autoCompactWindow before Claude execution or output mutation (A15)', async () => {
  const built = fixture({ reportUsage: true });
  const settings = path.join(built.trialRoot, 'claude-config', 'settings.json');
  const stale = JSON.stringify({ autoCompactWindow: 100_000 });
  write(settings, stale);

  const outcome = await runTrial(built);

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.terminal.state, 'failed');
  assert.equal(outcome.terminal.terminal_reason, 'protocol_violation');
  assert.match(outcome.stderr, /trial root must be fresh: claude-config[/\\]settings\.json/i);
  assert.equal(fs.existsSync(built.observation), false);
  assert.equal(fs.readFileSync(settings, 'utf8'), stale);
  assert.deepEqual(fs.readdirSync(built.trialRoot), ['claude-config']);
  assert.deepEqual(fs.readdirSync(built.options.trajectoryRoot), []);
}, 60_000);

// --- T13: normalized identity ---

// With correct code the compiled role and the spawned role cannot disagree — that is what R4 is
// for. The branch is therefore proven by injecting the defect class it guards against: the bytes
// the compiler hashed and the bytes the spawn surface is built from stop agreeing.
it('refuses a run whose spawned role diverges from the compiled role (R4)', async () => {
  const built = fixture();
  const directive = path.join(root, 'parent-directive.txt');
  const original = fs.readFileSync(directive);
  let reads = 0;
  const readFileSync = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, options: any) => {
    if (String(file) === directive && reads++ > 0) {
      return options ? 'Solve a different task.\n' : Buffer.from('Solve a different task.\n');
    }
    return readFileSync(file, options);
  }) as typeof fs.readFileSync);
  let outcome: RunOutcome;
  try {
    outcome = await runTrial(built);
  } finally {
    spy.mockRestore();
    fs.writeFileSync(directive, original);
  }
  assert.ok(reads >= 2, `directive was read ${reads} times`);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.terminal.state, 'failed');
  assert.equal(outcome.terminal.terminal_reason, 'protocol_violation');
  assert.match(outcome.stderr, /Role surface hash mismatch for slot 'parent'/);
  // Fail-closed: no backend process was admitted.
  assert.equal(fs.existsSync(built.observation), false);
}, 60_000);

// --- T14: normalized usage ---

// --- T15: the credential lease is echoed before the model process is admitted ---

// --- T16: F7/F8 — the composite manifest has a PRODUCER ON THE PRODUCTION PATH ---
//
// G4-PB7. Nothing below hands the runner a pre-built object. `fixture()` writes a real arm
// document, the SHIPPED `loadAgentRunConfigWithPolicy` compiles it, and `runTrial` drives the real
// `runOneShotAgent` — the same five-link chain G4-PB3 names, with no test helper, subclass or
// monkeypatch supplying what production must compose. The manifest is observed through the file F8
// publishes, which is the design's own acceptance surface (design:2817-2818), not through a spy.
// Before this wave the trajectory merge had NO production writer at all (§17 17.4.2).

it('G4-PB6: trajectory-merge-cli is NOT promoted to a bin, and F8 spawns no CLI (T17)', () => {
  // One production writer, one publication: a second route to the same publication turns the
  // `output_path_exists` hard failure into a race.
  const pkg = JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.bin), ['cortex', 'cortex-hook', 'cortex-run', 'cortex-task']);
  assert.equal(JSON.stringify(pkg.bin).includes('trajectory-merge'), false);
  // G4-PB5: the publication path contains no spawn. F8 runs after F2 has proven quiescence, so a
  // Node subprocess here would falsify the very evidence §9.4 G2 publishes.
  const source = fs.readFileSync(
    fileURLToPath(new URL('../../../src/domain/benchmark/composite-manifest.ts', import.meta.url)),
    'utf8',
  );
  // Asserted as the CAPABILITY, not as the word: `spawn` is also the name of a §9.2 edge kind, and
  // §9.2 is frozen, so a bare /spawn/ would only ever be satisfiable by renaming the design's own
  // vocabulary. What G4-PB5 forbids is reaching the process-spawning API at all.
  assert.equal(/child_process/.test(source), false);
  assert.equal(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(source), false);
});

// --- T18: F8 publishes the merged ATIF trajectory ON THE PRODUCTION PATH ---
//
// §9.5 F8 publishes "the composite manifest AND the merged recursive ATIF" (design:2815). Before
// this wave `mergeTrajectory` had ZERO production callers — its only non-test `src/` reference was
// `trajectory-merge-cli.ts:127`, and T17 above proves that CLI is deliberately not a bin. The
// trajectory is therefore observed through the file F8 publishes, driven by the real runner.

// --- T19: the §9.4 census is LOAD-BEARING, and its failure rides the shipped code 41 ---
//
// The structural shape here is PERFECT — one node, zero edges, a valid manifest. The only thing
// wrong is that the parent made a native subagent call nothing attests, which is exactly OC-11's
// invisibility. A census that is not evaluated cannot see it; that is the F21 pattern this test
// exists to refuse.

// --- T20: nodes[] and edges[] are DERIVED from the lifecycle pairs on disk ---
//
// The parent process cannot spawn a real pipeline thread under a fake backend, so the child's
// evidence is written the way the orchestrator writes it — through the SAME production writers
// (`writeStartedMarker`, `writeTerminalManifest`) into the SAME trajectory root
// (`benchmark-local-thread-orchestrator.ts:404,424`), carrying the trial's OWN policy identity.
// Nothing hands the runner a node, an edge or a manifest: it discovers the pair by scanning, and
// the assertion is made against the file F8 published.

function writeChildAttempt(built: Fixture, threadId: string, role: string): string {
  const root = built.options.trajectoryRoot;
  const identity = {
    modelExecutionIdentityHash: built.policy.identity.model_execution_identity_hash[role],
    roleToolSurfaceHash: built.policy.identity.role_tool_surface_hash[role],
    bundleManifestHash: built.policy.identity.bundle_manifest_hash,
  };
  const journalPath = path.join(root, `thread-${threadId}.journal.ndjson`);
  const at = '2026-08-01T00:00:01.000Z';
  const base = {
    schema_version: 'cortex-bench-journal/1', root_run_id: ROOT_RUN_ID, thread_id: threadId,
    agent_slot: role,
    model_execution_identity_hash: identity.modelExecutionIdentityHash,
    role_tool_surface_hash: identity.roleToolSurfaceHash,
    bundle_manifest_hash: identity.bundleManifestHash,
  };
  // A child that READ CACHE, which is what a real second turn does. The numbers follow the shipped
  // adapter's own convention (`adapter.ts:140-147`): `prompt_tokens` = input + cacheCreation +
  // cacheRead, `cached_tokens` = cacheRead, `tokens_in` = `prompt_tokens`. `cached_tokens` is
  // load-bearing: the runner's OWN terminal manifest carries no `cache_read` member at all
  // (`runner.ts:719-722`), so a summation over terminal manifests can never derive a cached total,
  // while the shipped accumulator can. That asymmetry is what makes the two producers distinguishable.
  const events = [
    { type: 'assistant_text', text: 'child works' },
    {
      type: 'cost_record', provider: 'anthropic', model: 'claude-reported-trial',
      tokens_in: 25, tokens_out: 2, prompt_tokens: 25, cached_tokens: 15, cost_usd: 0.001,
    },
    { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.001 },
  ];
  const prompt = 'c'.repeat(64);
  const records = [
    {
      ...base, type: 'run_header', seq: 0, ts: at, resolved_cwd: built.workspace,
      canonical_instruction_sha256: prompt, model_visible_prompt_sha256: prompt,
      system_prompt_sha256: prompt, tool_manifest_sha256: prompt, plugin_manifest_sha256: prompt,
    },
    ...events.map((event, index) => ({
      ...base, type: 'event', step: 1, seq: index + 1, ts: at,
      backend: 'claude', provider: 'anthropic',
      requested_model: 'claude-sonnet', reported_model: 'claude-reported-trial', event,
    })),
  ];
  const bytes = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  fs.writeFileSync(journalPath, bytes);

  writeStartedMarker({
    trajectoryRoot: root, rootRunId: ROOT_RUN_ID, threadId, journalPath,
    now: () => new Date(at),
  });
  // The real writer VALIDATES linkage against the journal bytes, so a child whose evidence does not
  // cohere cannot be written at all — which is what makes this a faithful stand-in for the
  // orchestrator rather than a hand-placed file.
  writeTerminalManifest({
    trajectoryRoot: root, rootRunId: ROOT_RUN_ID, threadId, state: 'completed',
    startedAt: at, endedAt: at, journalPath,
    journalSha256: createHash('sha256').update(bytes).digest('hex'),
    eventCount: events.length,
    steps: 1, costUsd: 0.001,
    tokens: { input: 25, output: 2, cache_read: 15, cache_creation: null },
    ...identity,
    terminalReason: 'ok',
  });
  return `thread-${threadId}`;
}

// --- T21: §9.6 A2/A5 — the journal side is the accumulator's, and it REFUSES rather than guess ---
//
// MGR-F1 and M1 meet here. §9.6 A2 (`design:2840`) names ONE producer for the journal side — "the
// shipped accumulator, which refuses to guess" — and marks the row `shipped`. When that accumulator
// refuses, EVERY journal figure is unavailable. It is not replaced by a second summation over the
// terminal manifests, and no operand is silently skipped: a sum that skipped the missing ones would
// publish a total meaning "the trial spent nothing" where the truth is "nobody knows what it spent".
//
// `steps` is the conjunct that separates the two producers in this direction. The terminal manifest
// carries `steps: 1` (T14 asserts it), so a summation over terminal manifests reports `available 1`
// here while the accumulator — which refused wholesale — has nothing to report.

// --- T22: G4-CM10 — an underivable non-nullable field REFUSES; it does not get a placeholder ---
//
// MGR-F3. A `direct` arm's child-template whitelist is EMPTY (`capabilities.ts:36,61`), so a thread
// attempt under one has no §9.1 field 12 the frozen policy can supply. G4-CM10 rules that case a
// `composite_manifest_invalid` refusal rather than a guess, and the refusal was pinned by nothing.
//
// This is the EMPTY-WHITELIST witness rather than the manager-mode one: it drives a real arm over a
// real seeded lifecycle pair through `runOneShotAgent` and observes the production refusal itself,
// where a manager-mode test could only pin the absence of a shipped template.

it('refuses a thread attempt whose §9.1 template is underivable (T22, G4-CM10)', async () => {
  const built = fixture();
  // Measured off the compiled policy, not assumed: `direct` derives NO child template.
  assert.deepEqual(built.policy.child_template_whitelist, []);
  // A `direct` arm compiles exactly one role, so the seeded pair enters under it. Inventing a
  // `benchmark-coder` identity here would make the fixture the authority on identity instead of
  // the frozen policy, and the merge's role-indexed M4 check would refuse it on those grounds
  // rather than on the one this test is about.
  writeChildAttempt(built, 'b1', 'parent');

  const outcome = await runTrial(built);
  const refusal = outcome.stderr.split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find(record => record?.reason === 'composite_manifest_invalid');
  assert.ok(refusal, `no typed refusal on stderr:\n${outcome.stderr}`);
  assert.equal(refusal.code, 40);
  assert.equal(refusal.code,
    BENCHMARK_FAILURES.find(f => f.reason === 'composite_manifest_invalid')!.code);
  // The refusal came from the DAG BUILDER, not from the structural validator: a document that got
  // as far as validation would carry named violations. A placeholder template produces exactly that
  // instead, which is how this assertion separates the two.
  assert.deepEqual(refusal.violations, []);
  // The message names the field and the cardinality that made it underivable, so the report is
  // actionable rather than merely typed.
  assert.match(outcome.stderr, /thread attempt template underivable: 0 whitelisted child templates/);
  assert.equal(outcome.exitCode, 1);

  // And it refused BEFORE F8 wrote anything at all.
  for (const name of ['composite-manifest.json', 'trajectory.json', 'trajectory.json.staging']) {
    assert.equal(
      fs.existsSync(path.join(built.options.trajectoryRoot, name)), false, `${name} exists`,
    );
  }
}, 60_000);

// --- T23: §9.5 F8's publication is ATOMIC — the refusal direction, and the two traps ---
//
// F8 publishes a PAIR (`design:2815`) and the step table forbids reordering. The composite manifest
// is written last because §9.5's grader-admission rule keys on it, and the checklist that decides
// admission reads the ATIF tree — so the tree must exist before the decision, and the decision can
// still refuse. A tree merged straight to its final path therefore survives a refused trial as a
// complete, collectable interchange document for a trial that published no manifest; and because
// the merge's `output_path_exists` is a HARD failure (`trajectory-merge.ts:648-653`), that residue
// turns any second attempt in the same artifacts root into that refusal instead of its real outcome.

it('REPORTS a discard it could not complete, rather than orphaning silently (T23c)', async () => {
  // The whole point of the discard is that no tree outlives a refused trial. A discard that fails
  // and says nothing leaves exactly the orphan B1 exists to prevent — and leaves it invisible.
  //
  // The obstruction is a real filesystem state, not a stub: something else occupies the staging
  // name as a non-empty directory. The merge refuses `output_path_exists` on it, C7 then fails
  // because no tree was published, and the discard cannot remove a directory (`rmSync`'s `force`
  // suppresses ENOENT only).
  const built = fixture({ accounted: true }, undefined, 'coder-review');
  writeChildAttempt(built, 'c1', 'benchmark-coder');
  const staging = path.join(built.options.trajectoryRoot, 'trajectory.json.staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'occupant'), 'not a trajectory\n');

  const outcome = await runTrial(built);
  assert.notEqual(outcome.exitCode, 0);
  assert.match(outcome.stderr, /atif discard failed/);
  assert.ok(outcome.stderr.includes(staging), `the report does not name the path:\n${outcome.stderr}`);
  // The obstruction is untouched — the run reported it instead of escalating to a recursive delete.
  assert.equal(fs.readFileSync(path.join(staging, 'occupant'), 'utf8'), 'not a trajectory\n');
}, 60_000);

// --- T24: §9.3 M1's link map is DERIVED FROM THE DAG, on a TOTAL order ---
//
// `deriveSubagentLinks` is the production function `attemptGraph` calls; T20 proves it is wired and
// what it produces end to end, and this proves what it computes. Pure inputs, pure output.

it('derives the subagent link map from the DAG in attempt-ordinal order (T24, §9.3 M1)', () => {
  const nodes = [
    { attempt_id: 'run-r1', thread_id: null, attempt_ordinal: 1 },
    { attempt_id: 'thread-a', thread_id: 'a', attempt_ordinal: 2 },
    { attempt_id: 'thread-b', thread_id: 'b', attempt_ordinal: 3 },
  ] as never as AttemptRecord[];
  const edges = [
    { kind: 'spawn', from: { ref: 'attempt', id: 'run-r1' }, to: { ref: 'attempt', id: 'thread-a' } },
    { kind: 'spawn', from: { ref: 'attempt', id: 'run-r1' }, to: { ref: 'attempt', id: 'thread-b' } },
  ] as never as AttemptEdge[];
  const call = (id: string, name = 'thread_run') => (
    { type: 'tool_use', name, toolUseId: id, input: {} } as never
  );
  const parentCalls = [call('call-1'), call('call-2')];
  const journals = (parent: never[]) => ([
    { attempt_id: 'run-r1', events: parent },
    { attempt_id: 'thread-a', events: [] },
    { attempt_id: 'thread-b', events: [] },
  ]);
  const paired = [{ callId: 'call-1', threadId: 'a' }, { callId: 'call-2', threadId: 'b' }];

  assert.deepEqual(deriveSubagentLinks(nodes, edges, journals(parentCalls)), paired);

  // THE REVERSED-EDGE CASE. `edges` is built by walking `observedLifecycleStems`, a bare unsorted
  // `readdirSync`, so its order is a directory-listing artefact. Pairing must follow G4-AI5's
  // `attempt_ordinal` (`started_at`, made total by `assignAttemptOrdinals`'s `attempt_id`
  // tie-break), so the SAME DAG with its edges reversed derives the SAME map. Zipping edges in
  // their own order returns `call-1 → b` — a silent mis-pair no merge check can catch, because
  // `nodeLinks` (`trajectory-merge.ts:562-575`) tests MEMBERSHIP in the child set, not identity.
  assert.deepEqual(deriveSubagentLinks(nodes, [edges[1], edges[0]], journals(parentCalls)), paired);

  // Both live names of the one tool. The merge indexes calls by both (`trajectory-merge.ts:283`),
  // and a map that missed the alias would be short by one link.
  assert.deepEqual(
    deriveSubagentLinks(nodes, edges, journals(
      [call('call-1'), call('call-2', 'mcp__cortex-benchmark-thread__thread_run')] as never[],
    )),
    paired,
  );

  // A trial with no thread at all derives an EMPTY map, not a null one: nothing was underivable.
  assert.deepEqual(deriveSubagentLinks(
    nodes.slice(0, 1), [], [{ attempt_id: 'run-r1', events: [] }],
  ), []);

  // Counts that disagree — a `thread_run` the §5.4 E2 call limit refused — are UNDERIVABLE, and the
  // WHOLE map is null rather than partial. `explicitLinksInCallOrder` requires a link for every
  // call a fragment made (`trajectory-merge.ts:375-377`), so a partial map is a hard merge refusal,
  // and guessing which call started which thread is exactly what §9.3 M1 forbids.
  assert.equal(
    deriveSubagentLinks(nodes, edges, journals([...parentCalls, call('call-3')] as never[])), null,
  );
  assert.equal(deriveSubagentLinks(nodes, edges, journals([call('call-1')] as never[])), null);

  // A child attempt with no `thread_id` names no thread, so the map is underivable rather than
  // carrying a link to nothing.
  const anonymous = [
    nodes[0], { ...nodes[1], thread_id: null }, nodes[2],
  ] as never as AttemptRecord[];
  assert.equal(deriveSubagentLinks(anonymous, edges, journals(parentCalls)), null);

  // A child the manifest never declared has no ordinal, so no total order exists over the children
  // and the pairing is underivable. Never sorted as if it came first.
  assert.equal(
    deriveSubagentLinks(nodes.slice(0, 2), edges, journals(parentCalls)), null,
  );
});

type BoundaryCheck = readonly [
  string, ProductionBoundaryScenario, (published: PublishedProductionBoundary) => void,
];

const PRODUCTION_BOUNDARY_CHECKS: BoundaryCheck[] = [
  ['direct root carries a real thread', 'direct', value => assert.equal(value.composite.nodes[0].thread_id, 'thr-root')],
  ['direct root is the exported root', 'direct', value => assert.equal(value.composite.roots.root_attempt_id, value.composite.nodes[0].attempt_id)],
  ['direct root comes from a production execution', 'direct', value => assert.equal(value.composite.nodes[0].attempt_id, 'execution-root')],
  ['terminal evidence has no stale supervisor field', 'direct', value => assert.equal(Object.hasOwn(value.terminalManifests[0], 'supervisor'), false)],
  ['terminal evidence uses schema v2', 'direct', value => assert.equal(value.terminalManifests[0].schema_version, 'cortex-bench-manifest/2')],
  ['terminal evidence carries four token categories', 'direct', value => assert.deepEqual(Object.keys(value.terminalManifests[0].tokens as object), ['input', 'output', 'cache_read', 'cache_creation'])],
  ['attempt identities are non-empty hashes', 'direct', value => assert.match(value.composite.nodes[0].model_execution_identity_hash, /^[a-f0-9]{64}$/)],
  ['journal references are non-empty', 'direct', value => assert.ok(value.composite.nodes[0].journal_path.length > 0)],
  ['terminal references are non-empty', 'direct', value => assert.ok(value.composite.nodes[0].terminal_manifest_path.length > 0)],
  ['audit coder-review exports coder and reviewer', 'coder-audit', value => assert.deepEqual(value.composite.nodes.map(node => node.role), ['coder', 'reviewer'])],
  ['audit coder-review links the reviewer to the coder', 'coder-audit', value => assert.ok(value.composite.edges.some(edge => edge.kind === 'spawn' && edge.from.id === 'execution-root' && edge.to.id === 'execution-review'))],
  ['reviewer-fix exports all production roles', 'coder-fix', value => assert.deepEqual(value.composite.nodes.map(node => node.role), ['coder', 'reviewer', 'fixer'])],
  ['reviewer-fix exports three real attempts', 'coder-fix', value => assert.equal(value.composite.nodes.length, 3)],
  ['manager Q&A-off exports dispatch topology', 'manager-qa-off', value => assert.ok(value.composite.edges.some(edge => edge.kind === 'dispatch'))],
  ['manager Q&A-off exports decomposition topology', 'manager-qa-off', value => assert.ok(value.composite.edges.some(edge => edge.kind === 'decompose'))],
  ['manager Q&A-on exports a durable question', 'manager-qa-on', value => assert.ok(value.composite.edges.some(edge => edge.kind === 'question'))],
  ['manager Q&A-on exports a durable answer', 'manager-qa-on', value => assert.ok(value.composite.edges.some(edge => edge.kind === 'answer'))],
  ['rework retains the superseded failed attempt', 'manager-history', value => assert.ok(value.composite.nodes.some(node => node.terminal_state === 'failed' && node.disposition === 'superseded'))],
  ['rework retains the rejected aborted attempt', 'manager-history', value => assert.ok(value.composite.nodes.some(node => node.terminal_state === 'aborted' && node.disposition === 'rejected'))],
];

it.each(PRODUCTION_BOUNDARY_CHECKS)(
  'production boundary: %s', async (_name, scenario, verify) => {
    await withPublishedProductionBoundary({ scenario }, published => verify(published));
  },
);
