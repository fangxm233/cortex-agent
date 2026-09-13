// input:  a resolved RunRequest driven through startAttempt over a real scripted backend
// output: durable per-attempt journal linkage and failure proofs
// pos:    Verifies production normalized-event journal persistence through the run layer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// The suite used to hand-build `AgentProcess` objects and drive them through the deleted facade.
// Its subject is the run layer's benchmark journal, so it now drives a REAL run: `startAttempt`
// freezes identity, opens the internal journal sink and feeds it the engine's raw
// `NormalizedEvent` tap. Claude is a scripted CLI child (via `request.isolation.spawner`); PI is a
// fake runtime (`pi-fake-runtime.ts`). No engine is faked.
//
// The raw stream is now the real backend's normalization, which differs from the hand-built
// fixture the suite used to feed (Claude's tap drops `session_started`, every backend appends
// `turn_complete`, PI's `session_started` carries a `sessionFile`). The journal assertions are
// therefore stated as "the journal persists exactly the run's raw tap, once, in order" plus the
// backend's literal event-type order — the fact the suite is about is unchanged.
//
// `startAttempt` closes its wire-level sinks when the attempt's stream ends, which is where the
// journal writes its index row; the suite therefore never closes the sink itself — if the run
// layer stopped doing it, the index-row assertions below would fail. The failure-injection cases
// drive a directly-constructed sink instead, so they can make `onEvent`/`onClose` throw on demand.

import '../../../_test-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { ClaudeAdapter } from '../../../../src/agent-adapter/claude/adapter.js';
import type { NormalizedEvent } from '../../../../src/agent-adapter/normalize/event-types.js';
import { PIAdapter } from '../../../../src/agent-adapter/pi/adapter.js';
import type { AgentProcessSpawner, Backend } from '../../../../src/agent-adapter/types.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../../src/core/types/thread-types.js';
import { AGENT_CWD, resolveSpawnCwd } from '../../../../src/core/paths.js';
import { canonicalJsonSha256 } from '../../../../src/domain/runs/observers/identity.js';
import { buildEngineSpec } from '../../../../src/domain/runs/engine-spec.js';
import {
  getProductionAttemptIdentity,
  freezeProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../../src/domain/runs/observers/production-attempt-identity.js';
import {
  createProductionAttemptJournalSink,
  getProductionAttemptJournal,
  initializeProductionAttemptJournals,
  resetProductionAttemptJournals,
} from '../../../../src/domain/runs/observers/production-attempt-journal.js';
import { startAttempt, type RunAttempt } from '../../../../src/domain/runs/attempt.js';
import { engines, SessionEngines } from '../../../../src/domain/runs/engines.js';
import type {
  ResolvedProfileConfig, RunAttemptConfig,
} from '../../../../src/domain/agents/profile-manager.js';
import type { RunRequest } from '../../../../src/domain/runs/request.js';
import {
  makeFakeRuntimeFactory, type FakeRuntimeFactory,
} from '../../../agent-adapter/pi-fake-runtime.js';
import { runRequestFixture } from '../../../run-request-fixture.js';

const TRIAL_ROUTE = { ANTHROPIC_BASE_URL: 'http://proxy.invalid/m/trial/anthropic' };
const SHA = 'a'.repeat(64);

let root: string;
let activeEvidence: ProductionBenchmarkEvidenceContext | null;
let pool: SessionEngines;
let piFake: FakeRuntimeFactory;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-attempt-journal-'));
  activeEvidence = null;
  resetProductionAttemptIdentity();
  resetProductionAttemptJournals();
  piFake = makeFakeRuntimeFactory();
  const piAdapter = new PIAdapter(
    piFake.factory,
    path.join(root, 'pi-sessions'),
    undefined,
    { agentDir: path.join(root, 'pi-agent') },
  );
  pool = new SessionEngines({ claude: new ClaudeAdapter(), pi: piAdapter });
  vi.spyOn(engines, 'acquire').mockImplementation((spec) => pool.acquire(spec));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pool.listKeys().map((key) => pool.close(key)));
  resetProductionAttemptIdentity();
  resetProductionAttemptJournals();
  fs.rmSync(root, { recursive: true, force: true });
});

function identityStorePath(): string {
  return path.join(root, 'data', 'benchmark-attempt-identities.jsonl');
}

function journalStorePath(): string {
  return path.join(root, 'data', 'benchmark-attempt-journals.jsonl');
}

function journalDir(): string {
  return path.join(root, 'data', 'benchmark-attempt-journals');
}

function evidence(
  backend: Backend,
  maxOutputTokens: number | null = null,
): ProductionBenchmarkEvidenceContext {
  return {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: 'trial-production-1', root_run_id: 'root-production-1',
    bundle_manifest_hash: SHA,
    model_execution: {
      model_alias_policy: { policy: 'exact' }, cli_name: backend,
      cli_version: `${backend}-fixture-1`, max_output_tokens: maxOutputTokens,
    },
  };
}

function initialize(backend: Backend): ProductionBenchmarkEvidenceContext {
  activeEvidence = evidence(backend);
  initializeProductionAttemptIdentity({
    storePath: identityStorePath(),
    configurationRevision: () => ({ profiles: 1, threads: 1 }),
  });
  initializeProductionAttemptJournals({ journalDir: journalDir(), storePath: journalStorePath() });
  return activeEvidence;
}

function profile(backend: Backend): ResolvedProfileConfig {
  return {
    name: `benchmark-${backend}`, model: `${backend}-model`, backend, mode: 'trial',
    provider: backend === 'claude' ? 'anthropic' : 'deepseek', fallback: [],
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
  };
}

function attemptOf(resolved: ResolvedProfileConfig): RunAttemptConfig {
  return {
    model: resolved.model, backend: resolved.backend, mode: resolved.mode,
    provider: resolved.provider, extraEnv: resolved.extraEnv, extraOption: resolved.extraOption,
    claudeBackend: resolved.claudeBackend, thinking: resolved.thinking,
  };
}

interface AttemptPath {
  label: string;
  template: string;
  role: string;
  stage: string | null;
  taskId: string | null;
}

const PATHS: AttemptPath[] = [
  { label: 'direct', template: 'benchmark-direct', role: 'benchmark-direct', stage: null, taskId: null },
  { label: 'coder-review', template: 'benchmark-coder-review', role: 'benchmark-coder', stage: 'implement', taskId: null },
  { label: 'manager/task-dispatch', template: 'benchmark-manager', role: 'benchmark-manager', stage: null, taskId: 'a1b2' },
];

interface AttemptTopology {
  threadId: string;
  rootThreadId: string;
  parentThreadId: string | null;
}

interface RequestOptions {
  evidenceContext?: ProductionBenchmarkEvidenceContext | null;
  cwd?: string;
  processSpawner?: AgentProcessSpawner;
  sessionKey?: string;
}

function makeRequest(
  backend: Backend,
  pathCase: AttemptPath,
  resolved: ResolvedProfileConfig,
  topology: AttemptTopology,
  opts: RequestOptions = {},
): RunRequest {
  const request = runRequestFixture({
    sessionKey: opts.sessionKey
      ?? `journal-${backend}-${pathCase.label.replaceAll('/', '-')}`,
    promptText: 'do work',
    threadId: topology.threadId,
    taskId: pathCase.taskId,
    taskProject: pathCase.taskId ? 'atlas' : null,
    taskGeneration: pathCase.taskId ? `generation-${topology.threadId}` : null,
    profileName: resolved.name,
    systemPrompt: 'System prompt',
    tools: 'Read,Write',
    pluginDirs: [],
    mcpComposition: 'none',
    disableHooks: true,
    loadCortexRules: false,
    recordCost: false,
    cwd: opts.cwd,
    processSpawner: opts.processSpawner,
  }, attemptOf(resolved));
  request.profile = resolved;
  request.benchmark = {
    evidenceContext: opts.evidenceContext === undefined ? activeEvidence : opts.evidenceContext,
    identityDirective: `Directive for ${pathCase.role}`,
    rootThreadId: topology.rootThreadId,
    parentThreadId: topology.parentThreadId,
    templateName: pathCase.template,
    agentSlotId: pathCase.role,
    stage: pathCase.stage,
    preserveUnreportedAccounting: false,
  };
  request.policy.background = 'none';
  return request;
}

function defaultTopology(executionId: string): AttemptTopology {
  return { threadId: `thr-${executionId}`, rootThreadId: `thr-${executionId}`, parentThreadId: null };
}

/** One successful Claude turn, as the CLI's stream-json would emit it. */
function claudeTurnScript(): unknown[] {
  return [
    { type: 'assistant', message: { model: 'reported-model', content: [{ type: 'text', text: 'done' }] } },
    {
      type: 'result', subtype: 'success', is_error: false, num_turns: 1,
      total_cost_usd: 0.01, session_id: 'backend-session', result: 'done',
      usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: { 'reported-model': {} },
    },
  ];
}

function scriptedChild(script: unknown[]): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  // A real child exits on SIGTERM, which is what rejects an in-flight turn. Model that so a
  // cancelled run settles instead of waiting on a process that never closes.
  child.kill = () => {
    setImmediate(() => {
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
    return true;
  };
  let emitted = false;
  child.stdin.on('data', () => {
    if (emitted) return;
    emitted = true;
    setImmediate(() => {
      for (const line of script) child.stdout.write(`${JSON.stringify(line)}\n`);
    });
  });
  return child;
}

function claudeSpawner(script: unknown[] = claudeTurnScript()): AgentProcessSpawner {
  return (() => ({ process: scriptedChild(script) })) as AgentProcessSpawner;
}

interface JournalRun {
  handle: RunAttempt;
  raw: NormalizedEvent[];
}

/** Drive one attempt through the run layer, tapping the same raw stream the journal receives. */
function startJournalAttempt(
  backend: Backend,
  request: RunRequest,
  resolved: ResolvedProfileConfig,
  executionId: string | null,
): JournalRun {
  const raw: NormalizedEvent[] = [];
  const handle = startAttempt({
    request, attempt: attemptOf(resolved), executionId,
    route: backend === 'claude' ? TRIAL_ROUTE : undefined,
    onEvent: () => {},
    requiredSinks: [{ onEvent: (event) => { raw.push(event); } }],
  });
  // A failing attempt rejects both results; the suite awaits `settled` and only needs one.
  void handle.foreground.catch(() => undefined);
  return { handle, raw };
}

async function finishRun(handle: RunAttempt, backend: Backend, piIndex = 0): Promise<void> {
  if (backend === 'pi') {
    const runtime = await piFake.runtime(piIndex);
    await runtime.nextCall('prompt');
    runtime.emitSimpleTurn('done', { usage: { cost: { total: 0.01 } } });
  }
  // `foreground` awaits the run's result AND its drained event loop. `settled` only settles when
  // the engine reaches a success terminal, so it cannot observe a failed/cancelled run.
  await handle.foreground;
}

function makeDirectJournal(
  backend: Backend,
  executionId: string,
  resolved: ResolvedProfileConfig,
): ReturnType<typeof createProductionAttemptJournalSink> {
  const request = makeRequest(backend, PATHS[0], resolved, defaultTopology(executionId));
  const spec = buildEngineSpec(request, attemptOf(resolved), {
    route: backend === 'claude' ? TRIAL_ROUTE : undefined,
    executionId,
  });
  const identity = freezeProductionAttemptIdentity({
    adapterBackend: backend, spec, request, executionId, resolvedProfile: resolved,
  });
  assert.ok(identity);
  return createProductionAttemptJournalSink({
    identity, spec,
    canonicalInstruction: request.benchmark?.identityDirective ?? '',
    message: request.prompt.text,
  });
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJournal(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}

function findOpenFd(filePath: string): number {
  const expected = fs.realpathSync(filePath);
  for (const entry of fs.readdirSync('/proc/self/fd')) {
    try {
      if (fs.realpathSync(`/proc/self/fd/${entry}`) === expected) return Number(entry);
    } catch {}
  }
  throw new Error(`open descriptor not found for ${filePath}`);
}

function onlyOpenJournalPath(): string {
  const files = fs.readdirSync(journalDir());
  assert.equal(files.length, 1);
  return path.join(journalDir(), files[0]);
}

test('records the exact model-visible role asset witnesses used by host finalization', async () => {
  const evidenceContext = initialize('pi');
  const resolved = profile('pi');
  const { handle } = startJournalAttempt(
    'pi', makeRequest('pi', PATHS[0], resolved, defaultTopology('exec-asset-witness'), { evidenceContext }),
    resolved, 'exec-asset-witness',
  );
  await finishRun(handle, 'pi');
  const evidenceRecord = getProductionAttemptJournal('exec-asset-witness');
  assert.ok(evidenceRecord);
  const header = readJournal(evidenceRecord.journal_path)[0];
  assert.equal(header.system_prompt_sha256, createHash('sha256').update('System prompt').digest('hex'));
  assert.equal(header.tool_manifest_sha256, canonicalJsonSha256(['Read', 'Write']));
  assert.equal(header.plugin_manifest_sha256, canonicalJsonSha256({
    plugin_dirs: [], skills: [],
  }));
});

test('records the cwd the backend was actually spawned with, not the server process cwd', async () => {
  const evidenceContext = initialize('pi');
  const resolved = profile('pi');
  const { handle } = startJournalAttempt(
    'pi', makeRequest('pi', PATHS[0], resolved, defaultTopology('exec-resolved-cwd'), { evidenceContext }),
    resolved, 'exec-resolved-cwd',
  );
  await finishRun(handle, 'pi');
  const evidenceRecord = getProductionAttemptJournal('exec-resolved-cwd');
  assert.ok(evidenceRecord);
  const header = readJournal(evidenceRecord.journal_path)[0];
  // The header and the adapter resolve the same expression, so a spawn that inherits the default
  // cannot be journalled as some other directory. Recording `process.cwd()` here would name the
  // directory the server was launched from, which is not where the model's tools run.
  assert.equal(piFake.requests.length, 1);
  assert.equal(header.resolved_cwd, piFake.requests[0].cwd);
  assert.equal(header.resolved_cwd, AGENT_CWD);
  assert.equal(header.resolved_cwd, resolveSpawnCwd(undefined));
});

test('journals an explicitly requested cwd verbatim', async () => {
  const evidenceContext = initialize('pi');
  const resolved = profile('pi');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-cwd-'));
  try {
    const { handle } = startJournalAttempt(
      'pi',
      makeRequest('pi', PATHS[0], resolved, defaultTopology('exec-explicit-cwd'), { evidenceContext, cwd: workspace }),
      resolved, 'exec-explicit-cwd',
    );
    await finishRun(handle, 'pi');
      const evidenceRecord = getProductionAttemptJournal('exec-explicit-cwd');
    assert.ok(evidenceRecord);
    assert.equal(readJournal(evidenceRecord.journal_path)[0].resolved_cwd, workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

for (const backend of ['claude', 'pi'] as const) {
  for (const pathCase of PATHS) {
    test(`journals every ${backend} ${pathCase.label} normalized event once and links frozen identity`, async () => {
      const evidenceContext = initialize(backend);
      const resolved = profile(backend);
      const executionId = `exec-${backend}-${pathCase.label.replace('/', '-')}`;
      const { handle, raw } = startJournalAttempt(
        backend,
        makeRequest(backend, pathCase, resolved, defaultTopology(executionId), {
          evidenceContext,
          processSpawner: backend === 'claude' ? claudeSpawner() : undefined,
        }),
        resolved, executionId,
      );
      await finishRun(handle, backend);
    
      const identity = getProductionAttemptIdentity(executionId);
      const evidenceRecord = getProductionAttemptJournal(executionId);
      assert.ok(identity && evidenceRecord);
      assert.equal(evidenceRecord.attempt_id, identity.attempt_id);
      assert.equal(evidenceRecord.execution_id, identity.execution_id);
      assert.equal(evidenceRecord.event_count, raw.length);
      // Literal normalized-event order per backend (the run's own raw tap is the authority for
      // content; the type order is the backend protocol fact the suite pins).
      assert.deepEqual(raw.map(event => event.type), backend === 'claude'
        ? ['assistant_text', 'turn_progress', 'cost_record', 'turn_complete']
        : ['session_started', 'assistant_text', 'turn_progress', 'cost_record', 'turn_complete']);
      assert.ok(path.isAbsolute(evidenceRecord.journal_path));
      assert.equal(evidenceRecord.journal_sha256, sha256(evidenceRecord.journal_path));
      const records = readJournal(evidenceRecord.journal_path);
      assert.deepEqual(records.slice(1).map(record => record.event), raw);
      assert.deepEqual(
        records.map(record => record.seq),
        Array.from({ length: raw.length + 1 }, (_, index) => index),
      );
    });
  }
}

type AttemptLifecycle =
  'completed' | 'failed' | 'rate-limited' | 'cancelled' | 'aborted' | 'interrupted';

function lifecycleScript(lifecycle: AttemptLifecycle): unknown[] {
  if (lifecycle === 'completed') return claudeTurnScript();
  if (lifecycle === 'aborted') {
    return [
      { type: 'assistant', message: { model: 'reported-model', content: [
        { type: 'tool_use', id: 'abort-1', name: 'thread_abort', input: { diagnosis: 'stop' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'abort-1', content: 'aborted' },
      ] } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, session_id: 'backend-session', result: 'aborted' },
    ];
  }
  if (lifecycle === 'cancelled') return [];
  const message = lifecycle === 'rate-limited'
    ? 'Server is temporarily limiting requests'
    : lifecycle === 'interrupted' ? 'interrupted' : 'failed';
  return [{
    type: 'result', subtype: 'error', is_error: true, result: message,
    session_id: 'backend-session', num_turns: 1,
    total_cost_usd: lifecycle === 'rate-limited' ? 0.01 : 0,
  }];
}

for (const lifecycle of [
  'completed', 'failed', 'rate-limited', 'cancelled', 'aborted', 'interrupted',
] as const) {
  test(`closes and persists an honest ${lifecycle} attempt journal`, async () => {
    const evidenceContext = initialize('claude');
    const resolved = profile('claude');
    const executionId = `exec-${lifecycle}`;
    const { handle, raw } = startJournalAttempt(
      'claude',
      makeRequest('claude', PATHS[0], resolved, defaultTopology(executionId), {
        evidenceContext, processSpawner: claudeSpawner(lifecycleScript(lifecycle)),
      }),
      resolved, executionId,
    );
    if (lifecycle === 'cancelled') handle.kill();
    let rejected = false;
    try { await handle.foreground; } catch { rejected = true; }
  
    const expectRejection = ['failed', 'cancelled', 'interrupted'].includes(lifecycle);
    assert.equal(rejected, expectRejection, `run rejection for ${lifecycle}`);
    const evidenceRecord = getProductionAttemptJournal(executionId);
    assert.ok(evidenceRecord);
    assert.equal(evidenceRecord.event_count, raw.length);
    assert.deepEqual(readJournal(evidenceRecord.journal_path).slice(1).map(row => row.event), raw);
    assert.equal(evidenceRecord.journal_sha256, sha256(evidenceRecord.journal_path));
  });
}

test('a synchronous adapter spawn failure still closes and links its zero-event attempt', () => {
  const evidenceContext = initialize('claude');
  const resolved = profile('claude');
  const request = makeRequest('claude', PATHS[0], resolved, defaultTopology('exec-spawn-failure'), {
    evidenceContext,
    processSpawner: (() => { throw new Error('spawn failed'); }) as AgentProcessSpawner,
  });
  assert.throws(
    () => startJournalAttempt('claude', request, resolved, 'exec-spawn-failure'),
    /spawn failed/,
  );
  const evidenceRecord = getProductionAttemptJournal('exec-spawn-failure');
  assert.ok(evidenceRecord);
  assert.equal(evidenceRecord.event_count, 0);
  assert.equal(evidenceRecord.journal_sha256, sha256(evidenceRecord.journal_path));
});

test('keeps concurrent child-thread attempt journals isolated and ordered', async () => {
  const evidenceContext = initialize('pi');
  const resolved = profile('pi');
  const executions = Array.from({ length: 6 }, (_, index) => `exec-concurrent-${index}`);
  const rootThreadId = `thr-${executions[0]}`;
  const runs = executions.map((executionId, index) => {
    const pathCase: AttemptPath = {
      label: `concurrent-${index}`, template: 'benchmark-coder-review',
      role: 'benchmark-coder', stage: 'implement', taskId: null,
    };
    return startJournalAttempt(
      'pi',
      makeRequest('pi', pathCase, resolved, {
        threadId: `thr-${executionId}`, rootThreadId,
        parentThreadId: index === 0 ? null : rootThreadId,
      }, { evidenceContext }),
      resolved, executionId,
    );
  });
  await Promise.all(runs.map(async ({ handle }, index) => {
    const runtime = await piFake.runtime(index);
    await runtime.nextCall('prompt');
    runtime.emitSimpleTurn('done', { usage: { cost: { total: 0.01 } } });
    await handle.foreground;
  }));

  const records = executions.map(executionId => getProductionAttemptJournal(executionId));
  assert.equal(new Set(records.map(record => record?.journal_path)).size, executions.length);
  records.forEach((record, index) => {
    assert.ok(record);
    assert.deepEqual(
      readJournal(record.journal_path).slice(1).map(row => row.event),
      runs[index].raw,
    );
  });
  assert.equal(
    fs.readFileSync(journalStorePath(), 'utf8').trimEnd().split('\n').length,
    executions.length,
  );
});

test('a recoverable required journal write failure cannot publish an incomplete index row', () => {
  initialize('claude');
  const sink = makeDirectJournal('claude', 'exec-write-failure', profile('claude'));
  let failNextWrite = false;
  const originalWrite = fs.writeSync;
  fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('injected event write failure');
    }
    return (originalWrite as (...inner: Parameters<typeof fs.writeSync>) => number)(...args);
  }) as typeof fs.writeSync;
  try {
    failNextWrite = true;
    assert.throws(
      () => sink.onEvent({ type: 'assistant_text', text: 'done' }),
      /trajectory|journal|sink/i,
    );
  } finally {
    fs.writeSync = originalWrite;
  }
  assert.throws(() => sink.onClose?.(), /trajectory|journal|sink/i);
  assert.equal(getProductionAttemptJournal('exec-write-failure'), null);
  assert.equal(fs.existsSync(journalStorePath()), false);
});

test('a required journal close failure never publishes placeholder evidence', () => {
  initialize('pi');
  const sink = makeDirectJournal('pi', 'exec-close-failure', profile('pi'));
  fs.closeSync(findOpenFd(onlyOpenJournalPath()));
  assert.throws(() => sink.onClose?.(), /trajectory|journal|sink/i);
  assert.equal(getProductionAttemptJournal('exec-close-failure'), null);
  assert.equal(fs.existsSync(journalStorePath()), false);
});

test('a journal close failure publishes nothing even when the fd close also fails', () => {
  initialize('pi');
  const sink = makeDirectJournal('pi', 'exec-send-close-double-fault', profile('pi'));
  const originalClose = fs.closeSync;
  fs.closeSync = (() => { throw new Error('close failed'); }) as typeof fs.closeSync;
  try {
    assert.throws(() => sink.onClose?.(), /trajectory|journal|sink/i);
  } finally {
    fs.closeSync = originalClose;
  }
  assert.equal(getProductionAttemptJournal('exec-send-close-double-fault'), null);
  assert.equal(fs.existsSync(journalStorePath()), false);
});

test('reload fails closed when persisted journal bytes no longer match their digest', async () => {
  const evidenceContext = initialize('claude');
  const resolved = profile('claude');
  const { handle } = startJournalAttempt(
    'claude',
    makeRequest('claude', PATHS[0], resolved, defaultTopology('exec-tampered'), {
      evidenceContext, processSpawner: claudeSpawner(),
    }),
    resolved, 'exec-tampered',
  );
  await finishRun(handle, 'claude');
  const evidenceRecord = getProductionAttemptJournal('exec-tampered');
  assert.ok(evidenceRecord);
  fs.appendFileSync(evidenceRecord.journal_path, '{}\n');
  resetProductionAttemptJournals();
  assert.throws(() => initializeProductionAttemptJournals({
    journalDir: journalDir(), storePath: journalStorePath(),
  }), /digest|event count|journal/i);
});

test('ordinary non-benchmark runs do not create production attempt evidence', async () => {
  initializeProductionAttemptJournals({ journalDir: journalDir(), storePath: journalStorePath() });
  initializeProductionAttemptIdentity({ storePath: identityStorePath() });
  const resolved = profile('claude');
  resolved.name = 'ordinary';
  const { handle } = startJournalAttempt(
    'claude',
    makeRequest('claude', PATHS[0], resolved, defaultTopology('exec-ordinary'), {
      evidenceContext: null, processSpawner: claudeSpawner(),
    }),
    resolved, 'exec-ordinary',
  );
  await finishRun(handle, 'claude');
  assert.equal(fs.existsSync(journalDir()), false);
  assert.equal(fs.existsSync(journalStorePath()), false);
});
