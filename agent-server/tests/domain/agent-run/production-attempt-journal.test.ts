// input:  production facade, spawn-linked identity, adapter events
// output: durable per-attempt journal linkage and failure proofs
// pos:    Verifies production normalized-event journal persistence
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { createEventStream } from '../../../src/agent-adapter/normalize/event-stream.js';
import type { NormalizedEvent } from '../../../src/agent-adapter/normalize/event-types.js';
import type {
  AgentAdapter, AgentProcess, AgentSpawnConfig, Backend,
} from '../../../src/agent-adapter/types.js';
import type { AgentResult } from '../../../src/core/types/agent-types.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../src/core/types/thread-types.js';
import {
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../src/domain/agent-run/production-attempt-identity.js';
import {
  getProductionAttemptJournal,
  initializeProductionAttemptJournals,
  resetProductionAttemptJournals,
} from '../../../src/domain/agent-run/production-attempt-journal.js';
import { canonicalJsonSha256 } from '../../../src/domain/agent-run/identity.js';
import type { ResolvedProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import { _test as facadeTest } from '../../../src/domain/agents/facade.js';

const TRIAL_ROUTE = { ANTHROPIC_BASE_URL: 'http://proxy.invalid/m/trial/anthropic' };

const SHA = 'a'.repeat(64);
const EVENTS: NormalizedEvent[] = [
  { type: 'session_started', sessionId: 'backend-session' },
  { type: 'assistant_text', text: 'done', model: 'reported-model' },
  {
    type: 'cost_record', provider: 'fixture-provider', model: 'reported-model',
    tokens_in: 3, tokens_out: 2, input_tokens: 3, output_tokens: 2,
    cache_read_tokens: 0, cache_creation_tokens: 0, provider_requests: 1,
    cost_usd: 0.01,
  },
];
const ABORT_EVENTS: NormalizedEvent[] = [
  { type: 'tool_use', toolUseId: 'abort-1', name: 'thread_abort', input: { diagnosis: 'stop' } },
  { type: 'tool_result', toolUseId: 'abort-1', ok: true, content: 'aborted' },
  { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.01 },
];

let root: string;
let evidenceContext: ProductionBenchmarkEvidenceContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-attempt-journal-'));
  resetProductionAttemptIdentity();
  resetProductionAttemptJournals();
});

afterEach(() => {
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

function initialize(backend: Backend, storePath = journalStorePath()): void {
  evidenceContext = {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: 'trial-production-1', root_run_id: 'root-production-1',
    bundle_manifest_hash: SHA,
    model_execution: {
      model_alias_policy: { policy: 'exact' }, cli_name: backend,
      cli_version: `${backend}-fixture-1`, max_output_tokens: null,
    },
  };
  initializeProductionAttemptIdentity({
    storePath: identityStorePath(),
    configurationRevision: () => ({ profiles: 1, threads: 1 }),
  });
  initializeProductionAttemptJournals({ journalDir: journalDir(), storePath });
}

function profile(backend: Backend): ResolvedProfileConfig {
  return {
    name: `benchmark-${backend}`, model: `${backend}-model`, backend, mode: 'trial',
    provider: backend === 'claude' ? 'anthropic' : 'deepseek', fallback: [],
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
  };
}

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: 'backend-session', finalOutput: 'done', num_turns: 1,
    total_cost_usd: 0.01, rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    ...overrides,
  };
}

type ProcessFactory = (spawnConfig: AgentSpawnConfig) => AgentProcess;

function eventProcess(
  events: readonly NormalizedEvent[], outcome: AgentResult | Error = result(),
  beforeEvent?: () => void,
): AgentProcess {
  return {
    sessionKey: 'fixture', sessionId: 'backend-session',
    send: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    events: {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          beforeEvent?.();
          beforeEvent = undefined;
          yield event;
        }
      },
    },
    close: async () => {}, kill: () => true,
  };
}

function adapter(backend: Backend, factory: ProcessFactory): AgentAdapter {
  return {
    backend, capabilities: new Set(), spawn: factory,
    close: async () => {}, kill: () => false, listSessions: () => [],
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

function runAttempt(
  backend: Backend, pathCase: AttemptPath, executionId: string,
  factory: ProcessFactory = () => eventProcess(EVENTS),
  topology: AttemptTopology = {
    threadId: `thr-${executionId}`, rootThreadId: `thr-${executionId}`, parentThreadId: null,
  },
) {
  const resolved = profile(backend);
  return facadeTest.runWithAdapter(adapter(backend, factory), 'do work', {
    executionId, threadId: topology.threadId, rootThreadId: topology.rootThreadId,
    parentThreadId: topology.parentThreadId, taskId: pathCase.taskId,
    taskProject: pathCase.taskId ? 'atlas' : null,
    taskGeneration: pathCase.taskId ? `generation-${executionId}` : null,
    templateName: pathCase.template, agentSlotId: pathCase.role, stage: pathCase.stage,
    profileName: resolved.name, resolvedProfileConfig: resolved,
    productionBenchmarkEvidenceContext: evidenceContext,
    identityDirective: `Directive for ${pathCase.role}`, systemPrompt: 'System prompt',
    tools: 'Read,Write', pluginDirs: [], mcpComposition: 'none', disableHooks: true,
    loadCortexRules: false, recordCost: false,
  }, {
    model: resolved.model, backend, mode: resolved.mode, provider: resolved.provider,
    extraEnv: resolved.extraEnv, extraOption: resolved.extraOption,
    claudeBackend: resolved.claudeBackend, thinking: resolved.thinking,
  }, backend === 'claude' ? TRIAL_ROUTE : undefined);
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJournal(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}

test('records the exact model-visible role asset witnesses used by host finalization', async () => {
  initialize('pi');
  await runAttempt('pi', PATHS[0], 'exec-asset-witness').promise;
  const evidence = getProductionAttemptJournal('exec-asset-witness');
  assert.ok(evidence);
  const header = readJournal(evidence.journal_path)[0];
  assert.equal(header.system_prompt_sha256, createHash('sha256').update('System prompt').digest('hex'));
  assert.equal(header.tool_manifest_sha256, canonicalJsonSha256(['Read', 'Write']));
  assert.equal(header.plugin_manifest_sha256, canonicalJsonSha256({
    plugin_dirs: [], skills: [],
  }));
});

for (const backend of ['claude', 'pi'] as const) {
  for (const pathCase of PATHS) {
    test(`journals every ${backend} ${pathCase.label} normalized event once and links frozen identity`, async () => {
      initialize(backend);
      const executionId = `exec-${backend}-${pathCase.label.replace('/', '-')}`;
      await runAttempt(backend, pathCase, executionId).promise;

      const identity = getProductionAttemptIdentity(executionId);
      const evidence = getProductionAttemptJournal(executionId);
      assert.ok(identity && evidence);
      assert.equal(evidence.attempt_id, identity.attempt_id);
      assert.equal(evidence.execution_id, identity.execution_id);
      assert.equal(evidence.event_count, EVENTS.length);
      assert.ok(path.isAbsolute(evidence.journal_path));
      assert.equal(evidence.journal_sha256, sha256(evidence.journal_path));
      const records = readJournal(evidence.journal_path);
      assert.deepEqual(records.slice(1).map(record => record.event), EVENTS);
      assert.deepEqual(records.map(record => record.seq), [0, 1, 2, 3]);
    });
  }
}

type AttemptLifecycle =
  'completed' | 'failed' | 'rate-limited' | 'cancelled' | 'aborted' | 'interrupted';

function lifecycleFactory(lifecycle: AttemptLifecycle): ProcessFactory {
  if (lifecycle === 'failed' || lifecycle === 'interrupted') {
    return () => eventProcess(EVENTS, new Error(lifecycle));
  }
  if (lifecycle === 'rate-limited') return () => eventProcess(EVENTS, result({
    rateLimited: true, rateLimitMessage: 'limited', rateLimitProvider: 'anthropic',
  }));
  if (lifecycle === 'aborted') return () => eventProcess(ABORT_EVENTS);
  if (lifecycle !== 'cancelled') return () => eventProcess(EVENTS);
  return () => {
    const stream = createEventStream<NormalizedEvent>();
    let reject!: (error: Error) => void;
    const pending = new Promise<AgentResult>((_resolve, rejectPromise) => { reject = rejectPromise; });
    queueMicrotask(() => EVENTS.forEach(stream.push));
    return {
      sessionKey: 'fixture', sessionId: 'backend-session', send: () => pending,
      events: stream.iterable, close: async () => { stream.close(); },
      kill: () => { stream.close(); reject(new Error('cancelled')); return true; },
    };
  };
}

for (const lifecycle of [
  'completed', 'failed', 'rate-limited', 'cancelled', 'aborted', 'interrupted',
] as const) {
  test(`closes and persists an honest ${lifecycle} attempt journal`, async () => {
    initialize('claude');
    const executionId = `exec-${lifecycle}`;
    const handle = runAttempt('claude', PATHS[0], executionId, lifecycleFactory(lifecycle));
    if (lifecycle === 'cancelled') handle.kill();
    if (['failed', 'cancelled', 'interrupted'].includes(lifecycle)) await assert.rejects(handle.promise);
    else await handle.promise;
    const evidence = getProductionAttemptJournal(executionId);
    assert.ok(evidence);
    const observed = lifecycle === 'cancelled' ? []
      : lifecycle === 'aborted' ? ABORT_EVENTS : EVENTS;
    assert.equal(evidence.event_count, observed.length);
    assert.deepEqual(readJournal(evidence.journal_path).slice(1).map(row => row.event), observed);
    assert.equal(evidence.journal_sha256, sha256(evidence.journal_path));
  });
}

test('a synchronous adapter spawn failure still closes and links its zero-event attempt', () => {
  initialize('claude');
  assert.throws(
    () => runAttempt('claude', PATHS[0], 'exec-spawn-failure', () => {
      throw new Error('spawn failed');
    }),
    /spawn failed/,
  );
  const evidence = getProductionAttemptJournal('exec-spawn-failure');
  assert.ok(evidence);
  assert.equal(evidence.event_count, 0);
  assert.equal(evidence.journal_sha256, sha256(evidence.journal_path));
});

test('keeps concurrent child-thread attempt journals isolated and ordered', async () => {
  initialize('pi');
  const attempts = Array.from({ length: 6 }, (_, index) => `exec-concurrent-${index}`);
  const rootThreadId = `thr-${attempts[0]}`;
  await Promise.all(attempts.map((executionId, index) => runAttempt(
    'pi', PATHS[1], executionId, () => eventProcess(EVENTS), {
      threadId: `thr-${executionId}`, rootThreadId,
      parentThreadId: index === 0 ? null : rootThreadId,
    },
  ).promise));
  const records = attempts.map(executionId => getProductionAttemptJournal(executionId));
  assert.equal(new Set(records.map(record => record?.journal_path)).size, attempts.length);
  for (const record of records) {
    assert.ok(record);
    assert.deepEqual(readJournal(record.journal_path).slice(1).map(row => row.event), EVENTS);
  }
  assert.equal(fs.readFileSync(journalStorePath(), 'utf8').trimEnd().split('\n').length, attempts.length);
});

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

test('a recoverable required journal write failure cannot publish an incomplete index row', async () => {
  initialize('claude');
  let killed = false;
  let failNextWrite = false;
  const originalWrite = fs.writeSync;
  fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('injected event write failure');
    }
    return (originalWrite as any)(...args);
  }) as typeof fs.writeSync;
  const factory = () => {
    const proc = eventProcess(EVENTS, result(), () => { failNextWrite = true; });
    proc.kill = () => { killed = true; return true; };
    return proc;
  };
  try {
    const handle = runAttempt('claude', PATHS[0], 'exec-write-failure', factory);
    await assert.rejects(handle.promise, /trajectory|journal|sink/i);
  } finally {
    fs.writeSync = originalWrite;
  }
  assert.equal(killed, true);
  assert.equal(getProductionAttemptJournal('exec-write-failure'), null);
  assert.equal(fs.existsSync(journalStorePath()), false);
});

test('a required journal close failure fails the run and never publishes placeholder evidence', async () => {
  initialize('pi');
  const factory = () => ({
    ...eventProcess([], result()),
    send: async () => {
      fs.closeSync(findOpenFd(onlyOpenJournalPath()));
      return result();
    },
  });
  await assert.rejects(
    runAttempt('pi', PATHS[0], 'exec-close-failure', factory).promise,
    /trajectory|journal|sink/i,
  );
  assert.equal(getProductionAttemptJournal('exec-close-failure'), null);
  assert.equal(fs.existsSync(journalStorePath()), false);
});

test('a synchronous send failure that also fails journal close still closes the process and publishes nothing', () => {
  initialize('pi');
  let closed = false;
  const factory = () => {
    const proc = eventProcess([], result());
    proc.send = () => {
      fs.closeSync(findOpenFd(onlyOpenJournalPath()));
      throw new Error('send failed');
    };
    proc.close = async () => { closed = true; };
    return proc;
  };
  assert.throws(
    () => runAttempt('pi', PATHS[0], 'exec-send-close-double-fault', factory),
    /trajectory|journal|sink/i,
  );
  assert.equal(closed, true);
  assert.equal(getProductionAttemptJournal('exec-send-close-double-fault'), null);
});

test('reload fails closed when persisted journal bytes no longer match their digest', async () => {
  initialize('claude');
  await runAttempt('claude', PATHS[0], 'exec-tampered').promise;
  const evidence = getProductionAttemptJournal('exec-tampered');
  assert.ok(evidence);
  fs.appendFileSync(evidence.journal_path, '{}\n');
  resetProductionAttemptJournals();
  assert.throws(() => initializeProductionAttemptJournals({
    journalDir: journalDir(), storePath: journalStorePath(),
  }), /digest|event count|journal/i);
});

test('ordinary non-benchmark runs do not create production attempt evidence', async () => {
  initializeProductionAttemptJournals({ journalDir: journalDir(), storePath: journalStorePath() });
  initializeProductionAttemptIdentity({ storePath: identityStorePath() });
  const ordinary = profile('claude');
  ordinary.name = 'ordinary';
  await facadeTest.runWithAdapter(adapter('claude', () => eventProcess(EVENTS)), 'x', {
    profileName: ordinary.name, resolvedProfileConfig: ordinary, recordCost: false,
  }, {
    model: ordinary.model, backend: 'claude', mode: ordinary.mode, provider: ordinary.provider,
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
  }, undefined).promise;
  assert.equal(fs.existsSync(journalDir()), false);
  assert.equal(fs.existsSync(journalStorePath()), false);
});
