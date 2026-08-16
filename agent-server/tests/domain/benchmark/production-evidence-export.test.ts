// input:  durable production attempts and launcher-owned arm facts
// output: input refusal, atomic v2, token and mirror coverage
// pos:    Production terminal/composite exporter contract tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ProductionAttemptIdentityRecord } from '../../../src/domain/agent-run/production-attempt-identity.js';
import type { ProductionAttemptJournalRecord } from '../../../src/domain/agent-run/production-attempt-journal.js';
import type { CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import type { ProductionTopologyFact } from '../../../src/domain/tasks/production-topology-ledger.js';
import type { ExecutionRecord } from '../../../src/store/execution-repo.js';
import type { ThreadRecord } from '../../../src/core/types/thread-types.js';
import type { Task } from '../../../src/core/task-parser.js';
import type { ProxyExport } from '../../../src/domain/benchmark/accounting-reconciliation.js';
import {
  exportProductionBenchmarkEvidence,
  type ProductionEvidenceExportInput,
  type ProductionEvidenceSources,
} from '../../../src/domain/benchmark/production-evidence-export.js';
import {
  validateCompositeManifest, type CompositeManifest,
} from '../../../src/domain/benchmark/composite-manifest.js';

const SHA = 'a'.repeat(64);
const BUNDLE = 'b'.repeat(64);
const START = '2026-08-16T00:00:00.000Z';
const END = '2026-08-16T00:00:02.000Z';

interface AttemptFixture {
  identity: ProductionAttemptIdentityRecord;
  journal: ProductionAttemptJournalRecord;
  execution: ExecutionRecord;
  thread: ThreadRecord;
  cost: CostEntry;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function topology(kind: ProductionTopologyFact['kind'], payload: object, index: number) {
  return {
    schema_version: 'cortex-production-topology/1', source: 'production_topology_ledger',
    fact_id: `fact-${index}`, order_key: String(index).padStart(4, '0'),
    occurred_at: `2026-08-16T00:00:01.${String(index).padStart(3, '0')}Z`,
    project: 'cortex-self', kind, ...payload,
  } as ProductionTopologyFact;
}

function journalBytes(input: {
  rootRunId: string; threadId: string; role: string; reportedModel?: string | null;
  rateLimited?: boolean;
}): Buffer {
  const header = {
    schema_version: 'cortex-bench-journal/1', type: 'run_header',
    root_run_id: input.rootRunId, thread_id: input.threadId, agent_slot: input.role,
    seq: 0, ts: START, resolved_cwd: '/workspace',
    canonical_instruction_sha256: SHA, model_visible_prompt_sha256: SHA,
    system_prompt_sha256: SHA, tool_manifest_sha256: SHA, plugin_manifest_sha256: SHA,
    model_execution_identity_hash: SHA, role_tool_surface_hash: SHA,
    bundle_manifest_hash: BUNDLE,
  };
  const events = input.rateLimited
    ? [{ type: 'rate_limit', raw: { status: 429 } }]
    : [{ type: 'assistant_text', text: 'done', model: input.reportedModel ?? 'model-native' }];
  const rows = [header, ...events.map((event, index) => ({
    schema_version: 'cortex-bench-journal/1', type: 'event',
    root_run_id: input.rootRunId, thread_id: input.threadId, step: null,
    agent_slot: input.role, seq: index + 1, ts: END, backend: 'claude',
    provider: 'anthropic', requested_model: 'model-requested',
    reported_model: input.reportedModel ?? 'model-native',
    model_execution_identity_hash: SHA, role_tool_surface_hash: SHA,
    bundle_manifest_hash: BUNDLE, event,
  }))];
  return Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function attemptFixture(root: string, input: {
  rootRunId: string; executionId: string; threadId: string; role: string;
  taskId: string; parentThreadId?: string | null; rootThreadId?: string;
  taskProject?: string | null; generation?: string | null;
  parentAttemptId?: string | null; rootAttemptId?: string;
  status?: 'completed' | 'failed' | 'cancelled'; threadStatus?: ThreadRecord['status'];
  abortReason?: string | null; rateLimited?: boolean; frozenAt?: string;
  cacheCreationTokens?: number | null;
}): AttemptFixture {
  const attemptId = `execution-${input.executionId}`;
  const bytes = journalBytes({
    rootRunId: input.rootRunId, threadId: input.threadId, role: input.role,
    rateLimited: input.rateLimited,
  });
  const journalPath = path.join(root, `${attemptId}.source.ndjson`);
  fs.writeFileSync(journalPath, bytes);
  const identity = {
    schema_version: 'cortex-production-attempt-identity/2', trial_id: 'trial-1',
    root_run_id: input.rootRunId, attempt_id: attemptId,
    root_attempt_id: input.rootAttemptId ?? attemptId,
    spawn_parent_attempt_id: input.parentAttemptId ?? null,
    execution_id: input.executionId, thread_id: input.threadId,
    parent_thread_id: input.parentThreadId ?? null,
    root_thread_id: input.rootThreadId ?? input.threadId,
    task_id: input.taskId, task_project: input.taskProject ?? null,
    dispatch_generation: input.generation ?? null, template: `template-${input.role}`,
    role: input.role, stage: null, profile_name: 'benchmark', backend: 'claude',
    provider: 'anthropic', requested_model: 'model-requested',
    model_execution_identity_hash: SHA, role_tool_surface_hash: SHA,
    bundle_manifest_hash: BUNDLE,
    frozen_at: input.frozenAt ?? '2026-08-16T00:00:00.500Z',
  } satisfies ProductionAttemptIdentityRecord;
  const journal = {
    schema_version: 'cortex-production-attempt-journal/1', attempt_id: attemptId,
    execution_id: input.executionId, journal_path: journalPath,
    journal_sha256: hash(bytes), event_count: 1, closed_at: END,
  } satisfies ProductionAttemptJournalRecord;
  const status = input.status ?? 'completed';
  const execution = {
    id: input.executionId, kind: 'thread', status, channel: 'benchmark', project: 'cortex-self',
    source: { trigger: 'benchmark' }, backend: 'claude', billingMode: 'api',
    session: { sessionId: null },
    thread: { threadId: input.threadId, agentSlotId: input.role }, dispatch: null,
    scheduleTaskId: null, runtime: { startedAt: START, updatedAt: END, endedAt: END },
    metrics: { costUsd: 0.25, numTurns: 1, durationS: 2 }, gpu: null,
    text: { label: input.role, finalOutput: null, error: status === 'failed' ? 'failed' : null },
  } satisfies ExecutionRecord;
  const thread = {
    id: input.threadId, status: input.threadStatus ?? (status === 'failed' ? 'failed' : 'completed'),
    abortReason: input.abortReason ?? null, endedAt: END,
    steps: status === 'failed' ? [] : [{ executionId: input.executionId }],
  } as ThreadRecord;
  const cost = {
    timestamp: END, project: 'cortex-self', trigger: 'thread', cost_usd: 0.25,
    num_turns: 1, duration_s: 2, backend: 'claude', mode: 'api', source: 'agent',
    input_tokens: 10, output_tokens: 4, prompt_tokens: 12, cache_read_tokens: 2,
    cache_creation_tokens: input.cacheCreationTokens ?? null,
    provider_requests: 1, execution_id: input.executionId,
    thread_id: input.threadId, parent_thread_id: input.parentThreadId ?? null,
    root_thread_id: input.rootThreadId ?? input.threadId, task_id: input.taskId,
    task_project: input.taskProject ?? null, dispatch_generation: input.generation ?? null,
    attempt_id: attemptId, root_attempt_id: input.rootAttemptId ?? attemptId,
    trial_id: 'trial-1', root_run_id: input.rootRunId,
  } satisfies CostEntry;
  return { identity, journal, execution, thread, cost };
}

function proxy(): ProxyExport {
  const unavailable = { status: 'unavailable', reason: 'counter_unreadable' } as const;
  return {
    schema_version: 'cortex-bench-proxy-export/1', trial_id: 'trial-1', adapter_id: 'proxy-1',
    requests: { status: 'available', value: 1 }, cached_tokens: unavailable,
    input_tokens: { status: 'available', value: 10 },
    output_tokens: { status: 'available', value: 4 }, audit_log: unavailable,
    lease_echo: unavailable, source: 'proxy_export',
  };
}

function task(id: string, parent: string | null): Task {
  return { id, parent, depends_on: [], project: 'cortex-self' } as Task;
}

function sources(
  attempts: readonly AttemptFixture[], facts: readonly ProductionTopologyFact[] = [],
  tasks: readonly Task[] = [],
): ProductionEvidenceSources {
  return {
    flush: async () => {},
    listIdentities: () => attempts.map(item => item.identity),
    getJournal: executionId => attempts.find(item => item.identity.execution_id === executionId)?.journal ?? null,
    getExecution: executionId => attempts.find(item => item.identity.execution_id === executionId)?.execution ?? null,
    getThread: threadId => attempts.find(item => item.identity.thread_id === threadId)?.thread ?? null,
    readCosts: async () => attempts.map(item => item.cost),
    readTopology: () => [...facts], readTasks: () => [...tasks],
  };
}

function exportInput(
  outputDirectory: string, mode: ProductionEvidenceExportInput['mode'],
  expectedRoles: readonly string[], managerQa: 'on' | 'off' | null = null,
) {
  return {
    outputDirectory, project: 'cortex-self', trialId: 'trial-1', rootRunId: 'root-1',
    armName: `arm-${mode}`, armCanonicalSha256: 'c'.repeat(64),
    bundleManifestHash: BUNDLE, mode, expectedRoles, managerQa,
    limits: { max_task_depth: mode === 'manager' ? 4 : 0, max_tasks: mode === 'manager' ? 8 : 0 },
    proxyExport: proxy(),
  } satisfies ProductionEvidenceExportInput;
}

function readComposite(directory: string): CompositeManifest {
  return JSON.parse(fs.readFileSync(path.join(directory, 'composite-manifest.json'), 'utf8'));
}

function atifIds(value: Record<string, unknown>): string[] {
  const children = (value.subagent_trajectories ?? []) as Record<string, unknown>[];
  return [String(value.trajectory_id), ...children.flatMap(atifIds)];
}

function pythonMirrorAccepts(directory: string, input: ProductionEvidenceExportInput): boolean {
  const composite = readComposite(directory);
  const root = composite.nodes.find(node => node.attempt_id === composite.roots.root_attempt_id)!;
  const terminalPath = path.join(directory, root.terminal_manifest_path);
  const terminal = JSON.parse(fs.readFileSync(terminalPath, 'utf8'));
  const payload = path.join(path.dirname(directory), `mirror-${path.basename(directory)}.json`);
  fs.writeFileSync(payload, JSON.stringify({ composite, terminal, input }));
  const script = [
    'import json,sys,pathlib,typing',
    'typing.override=getattr(typing,"override",lambda value:value)',
    'from cortex_bench_harness.inner_validation import valid_composite_structure',
    'from cortex_bench_harness.host_finalization import _parent_terminal_link,_validate_attempt_bytes',
    'x=json.load(open(sys.argv[1])); root=pathlib.Path(sys.argv[2])',
    'arm={"orchestration":{"mode":x["input"]["mode"]}}',
    'c=x["composite"]; t=x["terminal"]',
    'ok=valid_composite_structure(c,t,x["input"]["rootRunId"],x["input"]["trialId"],arm)',
    'rn=next(n for n in c["nodes"] if n["attempt_id"]==c["roots"]["root_attempt_id"])',
    'ok=ok and _parent_terminal_link(c,t,(root/rn["terminal_manifest_path"]).read_bytes(),x["input"]["rootRunId"])',
    '[_validate_attempt_bytes(root,n,n["terminal_manifest_path"],n["journal_path"]) for n in c["nodes"]]',
    'print("true" if ok else "false")',
  ].join(';');
  const env = {
    ...process.env,
    PYTHONPATH: path.resolve(process.cwd(), '../benchmark/harness/src'),
  };
  const harness = path.resolve(process.cwd(), '../benchmark/harness');
  return execFileSync(
    'uv', ['run', '--frozen', '--project', harness, 'python', '-c', script, payload, directory],
    { env, encoding: 'utf8' },
  ).trim() === 'true';
}

function coderScenario(root: string, withFixer: boolean): AttemptFixture[] {
  const rootAttempt = attemptFixture(root, {
    rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root', role: 'coder', taskId: 'trial-1',
  });
  const reviewer = attemptFixture(root, {
    rootRunId: 'root-1', executionId: 'review', threadId: 'thr-root', role: 'reviewer',
    taskId: 'trial-1', rootAttemptId: rootAttempt.identity.attempt_id,
    parentAttemptId: rootAttempt.identity.attempt_id,
    frozenAt: '2026-08-16T00:00:00.700Z',
  });
  if (!withFixer) return [rootAttempt, reviewer];
  const fixer = attemptFixture(root, {
    rootRunId: 'root-1', executionId: 'fix', threadId: 'thr-root', role: 'fixer',
    taskId: 'trial-1', rootAttemptId: rootAttempt.identity.attempt_id,
    parentAttemptId: reviewer.identity.attempt_id,
    frozenAt: '2026-08-16T00:00:00.900Z',
  });
  return [rootAttempt, reviewer, fixer];
}

function managerScenario(root: string, qa: boolean) {
  const manager = attemptFixture(root, {
    rootRunId: 'root-1', executionId: 'manager', threadId: 'thr-manager', role: 'manager',
    taskId: 'task-root', taskProject: 'cortex-self', generation: 'gen-root',
  });
  const child = attemptFixture(root, {
    rootRunId: 'root-1', executionId: 'child', threadId: 'thr-child', role: 'coder',
    taskId: 'task-child', taskProject: 'cortex-self', generation: 'gen-child',
    parentThreadId: 'thr-manager', rootThreadId: 'thr-manager',
    rootAttemptId: manager.identity.attempt_id, parentAttemptId: manager.identity.attempt_id,
  });
  const reviewer = attemptFixture(root, {
    rootRunId: 'root-1', executionId: 'child-review', threadId: 'thr-child', role: 'reviewer',
    taskId: 'task-child', taskProject: 'cortex-self', generation: 'gen-child',
    parentThreadId: 'thr-manager', rootThreadId: 'thr-manager',
    rootAttemptId: manager.identity.attempt_id, parentAttemptId: child.identity.attempt_id,
    frozenAt: '2026-08-16T00:00:00.700Z',
  });
  const facts = [
    topology('decompose', { actor_thread_id: 'thr-manager', parent_task_id: 'task-root', child_task_id: 'task-child' }, 1),
    topology('dispatch', { task_id: 'task-child', dispatch_generation: 'gen-child', thread_id: 'thr-child' }, 2),
    topology('delivery', { child_task_id: 'task-child', child_thread_id: 'thr-child', child_dispatch_generation: 'gen-child', parent_task_id: 'task-root', parent_thread_id: 'thr-manager', outcome: 'completed' }, 3),
    topology('verdict', { parent_task_id: 'task-root', manager_thread_id: 'thr-manager', child_task_id: 'task-child', child_thread_id: 'thr-child', child_dispatch_generation: 'gen-child', verdict: 'accepted', rework_round: 0 }, 4),
  ];
  if (qa) facts.push(
    topology('question', { question_id: 'q1', asker_thread_id: 'thr-child', asker_task_id: 'task-child', manager_thread_id: 'thr-manager', origin_channel: null, question: 'clarify', projectable: true }, 5),
    topology('answer', { question_id: 'q1', answerer_thread_id: 'thr-manager', answerer_channel: null, asker_thread_id: 'thr-child', answer: 'answer', consumed_at: END, projectable: true }, 6),
  );
  return {
    attempts: [manager, child, reviewer], facts,
    tasks: [task('task-root', null), task('task-child', 'task-root')],
  };
}

describe('production evidence export', () => {
  it('rejects malformed or incomplete launcher input before touching output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-input-invalid-'));
    try {
      for (const input of [null, {}, { outputDirectory: path.join(root, 'evidence') }]) {
        await expect(exportProductionBenchmarkEvidence(
          input as ProductionEvidenceExportInput, sources([]),
        )).rejects.toThrow(/production evidence export failed: .*missing|input must be an object/i);
      }
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['direct', false, false],
    ['coder-review', false, false],
    ['coder-review', true, false],
    ['manager', false, false],
    ['manager', false, true],
  ] as const)('publishes validator-admissible %s evidence (fixer=%s qa=%s)', async (mode, fixer, qa) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-export-'));
    try {
      const output = path.join(root, 'trajectory');
      const scenario = mode === 'direct'
        ? { attempts: [attemptFixture(root, { rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root', role: 'direct', taskId: 'trial-1' })], facts: [], tasks: [] }
        : mode === 'coder-review'
          ? { attempts: coderScenario(root, fixer), facts: [], tasks: [] }
          : managerScenario(root, qa);
      const roles = [...new Set(scenario.attempts.map(item => item.identity.role))];
      const input = exportInput(output, mode, roles, mode === 'manager' ? (qa ? 'on' : 'off') : null);
      const result = await exportProductionBenchmarkEvidence(input, sources(
        scenario.attempts, scenario.facts, scenario.tasks,
      ));
      const composite = readComposite(output);
      const violations = validateCompositeManifest(composite, {
        limits: input.limits,
        lifecycleStems: composite.nodes.map(node => node.attempt_id),
      });
      expect(violations).toEqual([]);
      expect(composite.roots.root_attempt_id).toBe(scenario.attempts[0].identity.attempt_id);
      expect(composite.nodes.every(node => node.thread_id !== null)).toBe(true);
      expect(composite.nodes.every(node => node.journal_sha256.length === 64)).toBe(true);
      expect(composite.accounting.journal.requests).toEqual({
        status: 'available', value: scenario.attempts.length,
      });
      expect(result.terminalPaths).toHaveLength(scenario.attempts.length);
      expect(fs.lstatSync(output).isDirectory()).toBe(true);
      const atif = JSON.parse(
        fs.readFileSync(path.join(output, 'trajectory.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(new Set(atifIds(atif))).toEqual(new Set(composite.nodes.map(node => node.attempt_id)));
      expect(pythonMirrorAccepts(output, input)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([null, 0, 7] as const)(
    'preserves cache-creation attribution %s through terminal, composite, and host validation',
    async (cacheCreationTokens) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-cache-creation-'));
      try {
        const attempt = attemptFixture(root, {
          rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root',
          role: 'direct', taskId: 'trial-1', cacheCreationTokens,
        });
        const output = path.join(root, 'trajectory');
        const input = exportInput(output, 'direct', ['direct']);
        await exportProductionBenchmarkEvidence(input, sources([attempt]));
        const composite = readComposite(output);
        const terminal = JSON.parse(fs.readFileSync(
          path.join(output, composite.nodes[0].terminal_manifest_path), 'utf8',
        )) as Record<string, unknown>;
        expect(composite.nodes[0].tokens.cache_creation).toBe(cacheCreationTokens);
        expect((terminal.tokens as Record<string, unknown>).cache_creation)
          .toBe(cacheCreationTokens);
        expect(pythonMirrorAccepts(output, input)).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('projects a direct rate-limited failure without weakening its evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-rate-limit-'));
    try {
      const attempt = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root',
        role: 'direct', taskId: 'trial-1', status: 'failed', rateLimited: true,
        cacheCreationTokens: 3,
      });
      const output = path.join(root, 'trajectory');
      const input = exportInput(output, 'direct', ['direct']);
      await exportProductionBenchmarkEvidence(input, sources([attempt]));
      const composite = readComposite(output);
      expect(composite.nodes[0]).toMatchObject({
        terminal_state: 'failed', terminal_reason: 'rate_limited',
        tokens: { cache_creation: 3 },
      });
      expect(pythonMirrorAccepts(output, input)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses negative cache-creation attribution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-cache-invalid-'));
    try {
      const attempt = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root',
        role: 'direct', taskId: 'trial-1', cacheCreationTokens: -1,
      });
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'trajectory'), 'direct', ['direct']), sources([attempt]),
      )).rejects.toThrow(/invalid counter/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves failed, aborted, rejected, and superseded production history', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-history-'));
    try {
      const scenario = managerScenario(root, false);
      const failed = scenario.attempts[2];
      failed.execution.status = 'failed';
      failed.thread.status = 'failed';
      scenario.facts[3] = topology('verdict', {
        parent_task_id: 'task-root', manager_thread_id: 'thr-manager',
        child_task_id: 'task-child', child_thread_id: 'thr-child',
        child_dispatch_generation: 'gen-child', verdict: 'rejected', rework_round: 1,
      }, 4);
      const replacement = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'replacement', threadId: 'thr-replacement', role: 'coder',
        taskId: 'task-child', taskProject: 'cortex-self', generation: 'gen-replacement',
        parentThreadId: 'thr-manager', rootThreadId: 'thr-manager',
        rootAttemptId: scenario.attempts[0].identity.attempt_id,
        parentAttemptId: failed.identity.attempt_id, threadStatus: 'aborted', abortReason: 'blocked',
        frozenAt: '2026-08-16T00:00:00.900Z',
      });
      scenario.facts.push(
        topology('rework', { task_id: 'task-child', rejected_thread_id: 'thr-child', rejected_dispatch_generation: 'gen-child', replacement_thread_id: 'thr-replacement', replacement_dispatch_generation: 'gen-replacement', rework_round: 1 }, 5),
        topology('dispatch', { task_id: 'task-child', dispatch_generation: 'gen-replacement', thread_id: 'thr-replacement' }, 6),
        topology('delivery', { child_task_id: 'task-child', child_thread_id: 'thr-replacement', child_dispatch_generation: 'gen-replacement', parent_task_id: 'task-root', parent_thread_id: 'thr-manager', outcome: 'blocked' }, 7),
        topology('verdict', { parent_task_id: 'task-root', manager_thread_id: 'thr-manager', child_task_id: 'task-child', child_thread_id: 'thr-replacement', child_dispatch_generation: 'gen-replacement', verdict: 'rejected', rework_round: 1 }, 8),
      );
      const output = path.join(root, 'trajectory');
      await exportProductionBenchmarkEvidence(
        exportInput(output, 'manager', ['manager', 'coder', 'reviewer'], 'off'),
        sources([...scenario.attempts, replacement], scenario.facts, scenario.tasks),
      );
      const nodes = readComposite(output).nodes;
      expect(nodes.find(node => node.attempt_id === failed.identity.attempt_id)).toMatchObject({
        terminal_state: 'failed', terminal_reason: 'child_failure', disposition: 'superseded',
      });
      expect(nodes.find(node => node.attempt_id === replacement.identity.attempt_id)).toMatchObject({
        terminal_state: 'aborted', terminal_reason: 'aborted', disposition: 'rejected',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without exposing a partial directory when a durable fact is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-missing-'));
    try {
      const attempt = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root', role: 'direct', taskId: 'trial-1',
      });
      const output = path.join(root, 'trajectory');
      const broken = sources([attempt]);
      broken.getJournal = () => null;
      await expect(exportProductionBenchmarkEvidence(
        exportInput(output, 'direct', ['direct']), broken,
      ))
        .rejects.toThrow(/journal/i);
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readdirSync(root).some(name => name.includes('.staging-'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses missing launcher roles and incomplete manager topology', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-shape-'));
    try {
      const direct = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root',
        role: 'direct', taskId: 'trial-1',
      });
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'direct'), 'direct', ['direct', 'reviewer']),
        sources([direct]),
      )).rejects.toThrow(/roles mismatch/i);
      const manager = managerScenario(root, false);
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'manager'), 'manager', ['manager', 'coder', 'reviewer'], 'off'),
        sources(manager.attempts, manager.facts.filter(fact => fact.kind !== 'verdict'), manager.tasks),
      )).rejects.toThrow(/verdict count is 0/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows unused Q&A-on but refuses unpaired Q&A, missing dependencies, and direct retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-closure-'));
    try {
      const manager = managerScenario(root, false);
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'qa-unused'), 'manager', ['manager', 'coder', 'reviewer'], 'on'),
        sources(manager.attempts, manager.facts, manager.tasks),
      )).resolves.toBeDefined();
      const unpaired = [...manager.facts, topology('question', {
        question_id: 'unpaired', asker_thread_id: 'thr-child', asker_task_id: 'task-child',
        manager_thread_id: 'thr-manager', origin_channel: null,
        question: 'missing answer', projectable: true,
      }, 9)];
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'qa-unpaired'), 'manager', ['manager', 'coder', 'reviewer'], 'on'),
        sources(manager.attempts, unpaired, manager.tasks),
      )).rejects.toThrow(/Q&A topology is unpaired/i);
      manager.tasks[1].depends_on = ['task-root'];
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'dependency'), 'manager', ['manager', 'coder', 'reviewer'], 'off'),
        sources(manager.attempts, manager.facts, manager.tasks),
      )).rejects.toThrow(/dependency topology mismatches/i);
      const first = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'direct-1', threadId: 'thr-direct',
        role: 'direct', taskId: 'trial-1',
      });
      const retry = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'direct-2', threadId: 'thr-direct',
        role: 'direct', taskId: 'trial-1', rootAttemptId: first.identity.attempt_id,
        parentAttemptId: first.identity.attempt_id, frozenAt: '2026-08-16T00:00:00.700Z',
      });
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'direct-retry'), 'direct', ['direct']),
        sources([first, retry]),
      )).rejects.toThrow(/requires one attempt/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes staged bytes when atomic publication fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-atomic-'));
    const originalPath = process.env.PATH;
    try {
      const attempt = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root',
        role: 'direct', taskId: 'trial-1',
      });
      const output = path.join(root, 'trajectory');
      process.env.PATH = '';
      await expect(exportProductionBenchmarkEvidence(
        exportInput(output, 'direct', ['direct']), sources([attempt]),
      )).rejects.toThrow(/ENOENT|spawn/i);
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readdirSync(root).some(name => name.includes('.staging-'))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses bundle drift and never overwrites a prior publication', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-drift-'));
    try {
      const attempt = attemptFixture(root, {
        rootRunId: 'root-1', executionId: 'root', threadId: 'thr-root', role: 'direct', taskId: 'trial-1',
      });
      const output = path.join(root, 'trajectory');
      const input = {
        ...exportInput(output, 'direct', ['direct']), bundleManifestHash: 'd'.repeat(64),
      };
      await expect(exportProductionBenchmarkEvidence(input, sources([attempt])))
        .rejects.toThrow(/bundle/i);
      fs.mkdirSync(output);
      fs.writeFileSync(path.join(output, 'owner'), 'first');
      await expect(exportProductionBenchmarkEvidence(
        exportInput(output, 'direct', ['direct']), sources([attempt]),
      ))
        .rejects.toThrow(/exists/i);
      expect(fs.readFileSync(path.join(output, 'owner'), 'utf8')).toBe('first');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
