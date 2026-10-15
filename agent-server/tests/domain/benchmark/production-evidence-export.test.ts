import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ProductionAttemptIdentityRecord } from '../../../src/domain/benchmark/production-attempt-identity.js';
import type { ProductionAttemptJournalRecord } from '../../../src/domain/benchmark/production-attempt-journal.js';
import type { CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import type { ExecutionRecord } from '../../../src/store/execution-repo.js';
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
const SESSION = 'session-1';

interface AttemptFixture {
  identity: ProductionAttemptIdentityRecord;
  journal: ProductionAttemptJournalRecord;
  execution: ExecutionRecord;
  cost: CostEntry;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function journalBytes(input: {
  rootRunId: string; sessionId: string; reportedModel?: string | null;
  rateLimited?: boolean; events?: readonly object[];
}): Buffer {
  const header = {
    schema_version: 'cortex-bench-journal/2', type: 'run_header',
    root_run_id: input.rootRunId, session_id: input.sessionId, agent_slot: 'direct',
    seq: 0, ts: START, resolved_cwd: '/workspace',
    canonical_instruction_sha256: SHA, model_visible_prompt_sha256: SHA,
    system_prompt_sha256: SHA, tool_manifest_sha256: SHA, plugin_manifest_sha256: SHA,
    model_execution_identity_hash: SHA, role_tool_surface_hash: SHA,
    bundle_manifest_hash: BUNDLE,
  };
  const events = input.events ?? (input.rateLimited
    ? [{ type: 'rate_limit', raw: { status: 429 } }]
    : [{ type: 'assistant_text', text: 'done', model: input.reportedModel ?? 'model-native' }]);
  const rows = [header, ...events.map((event, index) => ({
    schema_version: 'cortex-bench-journal/2', type: 'event',
    root_run_id: input.rootRunId, session_id: input.sessionId,
    agent_slot: 'direct', seq: index + 1, ts: END, backend: 'claude',
    provider: 'anthropic', requested_model: 'model-requested',
    reported_model: input.reportedModel ?? 'model-native',
    model_execution_identity_hash: SHA, role_tool_surface_hash: SHA,
    bundle_manifest_hash: BUNDLE, event,
  }))];
  return Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function attemptFixture(root: string, input: {
  executionId: string; rootRunId?: string; sessionId?: string;
  parentAttemptId?: string | null; rootAttemptId?: string;
  status?: 'completed' | 'failed' | 'cancelled'; rateLimited?: boolean; frozenAt?: string;
  cacheCreationTokens?: number | null; events?: readonly object[];
}): AttemptFixture {
  const attemptId = `execution-${input.executionId}`;
  const rootRunId = input.rootRunId ?? 'root-1';
  const sessionId = input.sessionId ?? SESSION;
  const bytes = journalBytes({
    rootRunId, sessionId, rateLimited: input.rateLimited, events: input.events,
  });
  const journalPath = path.join(root, `${attemptId}.source.ndjson`);
  fs.writeFileSync(journalPath, bytes);
  const identity = {
    schema_version: 'cortex-production-attempt-identity/5', trial_id: 'trial-1',
    root_run_id: rootRunId, attempt_id: attemptId,
    root_attempt_id: input.rootAttemptId ?? attemptId,
    spawn_parent_attempt_id: input.parentAttemptId ?? null,
    execution_id: input.executionId, session_id: sessionId,
    thinking: null, mode: 'plan', backend: 'claude',
    provider: 'anthropic', requested_model: 'model-requested',
    model_execution_identity_hash: SHA, role_tool_surface_hash: SHA,
    bundle_manifest_hash: BUNDLE,
    frozen_at: input.frozenAt ?? '2026-08-16T00:00:00.500Z',
  } satisfies ProductionAttemptIdentityRecord;
  const journal = {
    schema_version: 'cortex-production-attempt-journal/1', attempt_id: attemptId,
    execution_id: input.executionId, journal_path: journalPath,
    journal_sha256: hash(bytes), event_count: input.events?.length ?? 1, closed_at: END,
  } satisfies ProductionAttemptJournalRecord;
  const status = input.status ?? 'completed';
  const execution = {
    id: input.executionId, kind: 'local', status, channel: 'web:benchmark', project: 'general',
    source: { trigger: 'user' }, backend: 'claude', billingMode: 'api',
    session: { sessionId }, thread: null, dispatch: null,
    scheduleTaskId: null, runtime: { startedAt: START, updatedAt: END, endedAt: END },
    metrics: { costUsd: 0.25, numTurns: 1, durationS: 2 },
    text: { label: 'direct', finalOutput: null, error: status === 'failed' ? 'failed' : null },
  } satisfies ExecutionRecord;
  const cost = {
    timestamp: END, project: 'general', trigger: 'user', cost_usd: 0.25,
    num_turns: 1, duration_s: 2, backend: 'claude', mode: 'api', source: 'agent',
    input_tokens: 10, output_tokens: 4, prompt_tokens: 12, cache_read_tokens: 2,
    cache_creation_tokens: input.cacheCreationTokens ?? null,
    provider_requests: 1, execution_id: input.executionId, session_id: sessionId,
    attempt_id: attemptId, root_attempt_id: input.rootAttemptId ?? attemptId,
    trial_id: 'trial-1', root_run_id: rootRunId,
  } satisfies CostEntry;
  return { identity, journal, execution, cost };
}

/** Three runs of one session: the first opens the chain, each later one continues the last. */
function sessionChain(root: string): AttemptFixture[] {
  const first = attemptFixture(root, { executionId: 'turn-1' });
  const second = attemptFixture(root, {
    executionId: 'turn-2', rootAttemptId: first.identity.attempt_id,
    parentAttemptId: first.identity.attempt_id, frozenAt: '2026-08-16T00:00:00.700Z',
  });
  const third = attemptFixture(root, {
    executionId: 'turn-3', rootAttemptId: first.identity.attempt_id,
    parentAttemptId: second.identity.attempt_id, frozenAt: '2026-08-16T00:00:00.900Z',
  });
  return [first, second, third];
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

function sources(attempts: readonly AttemptFixture[]): ProductionEvidenceSources {
  return {
    flush: async () => {},
    listIdentities: () => attempts.map(item => item.identity),
    getJournal: executionId => attempts.find(item => item.identity.execution_id === executionId)?.journal ?? null,
    getExecution: executionId => attempts.find(item => item.identity.execution_id === executionId)?.execution ?? null,
    readCosts: async () => attempts.map(item => item.cost),
  };
}

function exportInput(outputDirectory: string) {
  return {
    outputDirectory, trialId: 'trial-1', rootRunId: 'root-1',
    armName: 'arm-direct', armCanonicalSha256: 'c'.repeat(64),
    bundleManifestHash: BUNDLE, proxyExport: proxy(),
  } satisfies ProductionEvidenceExportInput;
}

function readComposite(directory: string): CompositeManifest {
  return JSON.parse(fs.readFileSync(path.join(directory, 'composite-manifest.json'), 'utf8'));
}

function atifIds(value: Record<string, unknown>): string[] {
  const children = (value.subagent_trajectories ?? []) as Record<string, unknown>[];
  return [String(value.trajectory_id), ...children.flatMap(atifIds)];
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

  it('rejects string-coercible predicate results', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-input-coerced-'));
    try {
      // A `fail` verdict wrapped in an array would clear an allowlist that coerces to text and
      // then slip past the `=== 'fail'` refusal, publishing a failed predicate verbatim.
      const input = {
        ...exportInput(path.join(root, 'evidence')),
        evaluatedChecks: { G1: { result: ['fail'], detail: 'boom' } },
      };
      await expect(exportProductionBenchmarkEvidence(
        input as unknown as ProductionEvidenceExportInput, sources([]),
      )).rejects.toThrow(/evaluated check G1 result is invalid/);
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a one-run session', false],
    ['a session whose runs chain', true],
  ] as const)('publishes validator-admissible evidence for %s', async (_label, chained) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-export-'));
    try {
      const output = path.join(root, 'trajectory');
      const attempts = chained ? sessionChain(root) : [attemptFixture(root, { executionId: 'root' })];
      const result = await exportProductionBenchmarkEvidence(exportInput(output), sources(attempts));
      const composite = readComposite(output);
      const violations = validateCompositeManifest(composite, {
        lifecycleStems: composite.nodes.map(node => node.attempt_id),
      });
      expect(violations).toEqual([]);
      expect(composite.predicate.mode).toBe('direct');
      expect(composite.roots).toEqual({
        root_attempt_id: attempts[0].identity.attempt_id, root_task_id: null,
      });
      expect(composite.nodes.every(node => node.session_id === SESSION)).toBe(true);
      expect(composite.nodes.map(node => node.execution_id))
        .toEqual(attempts.map(item => item.identity.execution_id));
      expect(composite.nodes.every(node => node.role === 'direct')).toBe(true);
      expect(composite.nodes.every(node => node.journal_sha256.length === 64)).toBe(true);
      expect(composite.edges).toEqual(attempts.slice(1).map(item => ({
        kind: 'spawn',
        from: { ref: 'attempt', id: item.identity.spawn_parent_attempt_id },
        to: { ref: 'attempt', id: item.identity.attempt_id },
      })));
      expect(composite.accounting.journal.requests).toEqual({
        status: 'available', value: attempts.length,
      });
      expect(result.terminalPaths).toHaveLength(attempts.length);
      expect(fs.lstatSync(output).isDirectory()).toBe(true);
      const atif = JSON.parse(
        fs.readFileSync(path.join(output, 'trajectory.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(atifIds(atif)).toEqual(attempts.map(item => item.identity.attempt_id));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('exports a call batch a heartbeat interrupted, instead of condemning the journal', async () => {
    // `context_usage` is emitted every couple of seconds, so it lands between two calls of one
    // batch whenever the model issues them a moment apart. The call phase used to end at the first
    // event that was not a call, which registered only `call-a`; `call-b`'s result then answered a
    // batch that had never opened it and the whole journal was refused `unpaired_tool_result`,
    // aborting the trial before the verifier ran.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-heartbeat-batch-'));
    try {
      const attempt = attemptFixture(root, {
        executionId: 'root',
        events: [
          { type: 'tool_use', toolUseId: 'call-a', name: 'bash', input: {} },
          { type: 'context_usage', usedTokens: 1024 },
          { type: 'tool_use', toolUseId: 'call-b', name: 'bash', input: {} },
          { type: 'tool_result', toolUseId: 'call-a', content: 'a' },
          { type: 'tool_result', toolUseId: 'call-b', content: 'b' },
          { type: 'assistant_text', text: 'done', model: 'model-native' },
        ],
      });
      const output = path.join(root, 'trajectory');
      const result = await exportProductionBenchmarkEvidence(exportInput(output), sources([attempt]));

      expect(result.terminalPaths).toHaveLength(1);
      const atif = JSON.parse(
        fs.readFileSync(path.join(output, 'trajectory.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(atifIds(atif)).toEqual([attempt.identity.attempt_id]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([null, 0, 7] as const)(
    'preserves cache-creation attribution %s through terminal, composite, and host validation',
    async (cacheCreationTokens) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-cache-creation-'));
      try {
        const attempt = attemptFixture(root, { executionId: 'root', cacheCreationTokens });
        const output = path.join(root, 'trajectory');
        await exportProductionBenchmarkEvidence(exportInput(output), sources([attempt]));
        const composite = readComposite(output);
        const terminal = JSON.parse(fs.readFileSync(
          path.join(output, composite.nodes[0].terminal_manifest_path), 'utf8',
        )) as Record<string, unknown>;
        expect(composite.nodes[0].tokens.cache_creation).toBe(cacheCreationTokens);
        expect((terminal.tokens as Record<string, unknown>).cache_creation)
          .toBe(cacheCreationTokens);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('projects a rate-limited failure without weakening its evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-rate-limit-'));
    try {
      const attempt = attemptFixture(root, {
        executionId: 'root', status: 'failed', rateLimited: true, cacheCreationTokens: 3,
      });
      const output = path.join(root, 'trajectory');
      await exportProductionBenchmarkEvidence(exportInput(output), sources([attempt]));
      const composite = readComposite(output);
      expect(composite.nodes[0]).toMatchObject({
        terminal_state: 'failed', terminal_reason: 'rate_limited',
        tokens: { cache_creation: 3 },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps every run of the session on the record, whatever each one ended in', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-history-'));
    try {
      const [first, second, third] = sessionChain(root);
      first.execution.status = 'failed';
      second.execution.status = 'cancelled';
      const output = path.join(root, 'trajectory');
      await exportProductionBenchmarkEvidence(exportInput(output), sources([first, second, third]));
      const nodes = readComposite(output).nodes;
      expect(nodes.map(node => [node.execution_id, node.terminal_state, node.terminal_reason]))
        .toEqual([
          ['turn-1', 'failed', 'child_failure'],
          ['turn-2', 'cancelled', 'cancelled'],
          ['turn-3', 'completed', 'ok'],
        ]);
      expect(nodes.every(node => node.disposition === 'none')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses negative cache-creation attribution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-cache-invalid-'));
    try {
      const attempt = attemptFixture(root, { executionId: 'root', cacheCreationTokens: -1 });
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'trajectory')), sources([attempt]),
      )).rejects.toThrow(/invalid counter/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without exposing a partial directory when a durable fact is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-missing-'));
    try {
      const attempt = attemptFixture(root, { executionId: 'root' });
      const output = path.join(root, 'trajectory');
      const broken = sources([attempt]);
      broken.getJournal = () => null;
      await expect(exportProductionBenchmarkEvidence(exportInput(output), broken))
        .rejects.toThrow(/journal/i);
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readdirSync(root).some(name => name.includes('.staging-'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a run the session did not own and evidence the session never wrote', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-session-linkage-'));
    try {
      const foreignRun = attemptFixture(root, { executionId: 'root' });
      foreignRun.execution.session.sessionId = 'session-other';
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'foreign-run')), sources([foreignRun]),
      )).rejects.toThrow(/execution linkage mismatch/i);

      const foreignCost = attemptFixture(root, { executionId: 'root' });
      foreignCost.cost.session_id = 'session-other';
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'foreign-cost')), sources([foreignCost]),
      )).rejects.toThrow(/cost attribution mismatch/i);

      const foreignJournal = attemptFixture(root, { executionId: 'root' });
      const bytes = journalBytes({ rootRunId: 'root-1', sessionId: 'session-other' });
      fs.writeFileSync(foreignJournal.journal.journal_path, bytes);
      foreignJournal.journal = { ...foreignJournal.journal, journal_sha256: hash(bytes) };
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'foreign-journal')), sources([foreignJournal]),
      )).rejects.toThrow(/session mismatch/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a trial run whose attempts do not resolve to one root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-roots-'));
    try {
      const first = attemptFixture(root, { executionId: 'first' });
      const second = attemptFixture(root, {
        executionId: 'second', frozenAt: '2026-08-16T00:00:00.700Z',
      });
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'two-roots')), sources([first, second]),
      )).rejects.toThrow(/root resolves to 2 attempts/i);
      await expect(exportProductionBenchmarkEvidence(
        exportInput(path.join(root, 'no-root')), sources([]),
      )).rejects.toThrow(/root resolves to 0 attempts/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes staged bytes when atomic publication fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-atomic-'));
    const originalPath = process.env.PATH;
    try {
      const attempt = attemptFixture(root, { executionId: 'root' });
      const output = path.join(root, 'trajectory');
      process.env.PATH = '';
      await expect(exportProductionBenchmarkEvidence(exportInput(output), sources([attempt])))
        .rejects.toThrow(/ENOENT|spawn/i);
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
      const attempt = attemptFixture(root, { executionId: 'root' });
      const output = path.join(root, 'trajectory');
      const input = { ...exportInput(output), bundleManifestHash: 'd'.repeat(64) };
      await expect(exportProductionBenchmarkEvidence(input, sources([attempt])))
        .rejects.toThrow(/bundle/i);
      fs.mkdirSync(output);
      fs.writeFileSync(path.join(output, 'owner'), 'first');
      await expect(exportProductionBenchmarkEvidence(exportInput(output), sources([attempt])))
        .rejects.toThrow(/exists/i);
      expect(fs.readFileSync(path.join(output, 'owner'), 'utf8')).toBe('first');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
