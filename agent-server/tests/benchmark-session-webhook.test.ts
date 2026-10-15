import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventBus } from '../src/events/index.js';
import {
  _resetBenchmarkSessions,
  handleBenchmarkSessionWebhook,
  type BenchmarkSessionDeps,
} from '../src/orchestration/benchmark-session-webhook.js';
import {
  _resetSessionEvidence,
  sessionEvidenceContext,
  sessionBenchmarkMaxOutputTokens,
} from '../src/domain/benchmark/session-evidence.js';

const CONTEXT = {
  schema_version: 'cortex-production-benchmark-evidence-context/1',
  trial_id: 'trial-1',
  root_run_id: 'root-1',
  bundle_manifest_hash: 'b'.repeat(64),
  model_execution: {
    model_alias_policy: null,
    cli_name: 'pi',
    cli_version: '1.0.0',
    max_output_tokens: 65536,
  },
} as const;

interface Harness {
  deps: BenchmarkSessionDeps;
  bus: EventBus;
  created: string[];
  delivered: Array<{ channel: string; text: string }>;
  finishDelivery(error?: Error): void;
  busy: Set<string>;
  boundAtDelivery: unknown[];
}

function harness(): Harness {
  const bus = new EventBus();
  const created: string[] = [];
  const delivered: Array<{ channel: string; text: string }> = [];
  const boundAtDelivery: unknown[] = [];
  const busy = new Set<string>();
  let settle: ((error?: Error) => void) | null = null;
  const deps: BenchmarkSessionDeps = {
    createSession: async (projectId) => {
      created.push(projectId);
      const n = created.length;
      return { sessionId: `session-${n}`, channel: `web:session-${n}` };
    },
    deliver: (channel, text) => {
      delivered.push({ channel, text });
      boundAtDelivery.push(sessionEvidenceContext(channel.replace('web:', '')));
      return new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      });
    },
    isBusy: (sessionId) => busy.has(sessionId),
    executionIds: (sessionId) => [`${sessionId}-exec-1`, `${sessionId}-exec-2`],
    bus: () => bus,
  };
  return {
    deps, bus, created, delivered, busy, boundAtDelivery,
    finishDelivery: (error) => settle?.(error),
  };
}

function turnCompleted(bus: EventBus, sessionId: string, status: 'completed' | 'failed' | 'stopped', finalOutput: string) {
  bus.publish({
    type: 'session.turn.completed', sessionId, channel: `web:${sessionId}`,
    status, finalOutput, trigger: 'web-user',
  });
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('benchmark-session webhook', () => {
  beforeEach(() => {
    _resetBenchmarkSessions();
    _resetSessionEvidence();
  });
  afterEach(() => {
    _resetBenchmarkSessions();
    _resetSessionEvidence();
  });

  it('answers ping and refuses unknown actions', async () => {
    const h = harness();
    expect(await handleBenchmarkSessionWebhook({ action: 'ping' }, h.deps))
      .toEqual({ success: true, data: { ready: true } });
    expect(await handleBenchmarkSessionWebhook({ action: 'list' }, h.deps))
      .toEqual({ success: false, error: 'unknown action: list' });
  });

  it('starts a session bound to the trial context, then reports its turn outcome', async () => {
    const h = harness();
    const started = await handleBenchmarkSessionWebhook({
      action: 'start', message: '  solve the task  ', productionBenchmarkEvidenceContext: CONTEXT,
    }, h.deps);
    expect(started).toEqual({
      success: true, data: { sessionId: 'session-1', channel: 'web:session-1', status: 'running' },
    });
    expect(h.created).toEqual(['general']);
    expect(h.delivered).toEqual([{ channel: 'web:session-1', text: 'solve the task' }]);
    // The context is bound before the message goes in, so the first run already carries it.
    expect(h.boundAtDelivery).toEqual([CONTEXT]);

    let status = await handleBenchmarkSessionWebhook({ action: 'status', sessionId: 'session-1' }, h.deps);
    expect(status.data).toMatchObject({ running: true, terminal: false, status: 'running', turns: 0 });

    turnCompleted(h.bus, 'session-1', 'completed', 'all done');
    h.busy.add('session-1');
    h.finishDelivery();
    await flush();
    status = await handleBenchmarkSessionWebhook({ action: 'status', sessionId: 'session-1' }, h.deps);
    expect(status.data).toMatchObject({ running: true, status: 'running', turns: 1 });

    h.busy.delete('session-1');
    status = await handleBenchmarkSessionWebhook({ action: 'status', sessionId: 'session-1' }, h.deps);
    expect(status).toEqual({
      success: true,
      data: {
        sessionId: 'session-1', channel: 'web:session-1', running: false, terminal: true,
        status: 'completed', turns: 1, finalOutput: 'all done', error: null,
        executionIds: ['session-1-exec-1', 'session-1-exec-2'],
      },
    });
  });

  it('binds the benchmark-only output cap before delivering the first turn', async () => {
    const h = harness();
    const reply = await handleBenchmarkSessionWebhook({
      action: 'start', message: 'task', productionBenchmarkEvidenceContext: CONTEXT,
      benchmarkMaxOutputTokens: 65536,
    }, h.deps);
    expect(reply.success).toBe(true);
    expect(sessionBenchmarkMaxOutputTokens('session-1')).toBe(65536);
    expect(sessionBenchmarkMaxOutputTokens('ordinary-session')).toBeUndefined();
  });

  it.each([0, -1, 1.5, '65536', Infinity, 1024])('rejects an invalid or drifting cap %s before creating a session', async (cap) => {
    const h = harness();
    const reply = await handleBenchmarkSessionWebhook({
      action: 'start', message: 'task', productionBenchmarkEvidenceContext: CONTEXT,
      benchmarkMaxOutputTokens: cap,
    }, h.deps);
    expect(reply.success).toBe(false);
    expect(h.created).toEqual([]);
  });

  it('reports the last turn when the session ran more than one', async () => {
    const h = harness();
    await handleBenchmarkSessionWebhook({
      action: 'start', message: 'task', productionBenchmarkEvidenceContext: CONTEXT, projectId: 'bench',
    }, h.deps);
    expect(h.created).toEqual(['bench']);
    turnCompleted(h.bus, 'session-1', 'completed', 'first');
    turnCompleted(h.bus, 'session-other', 'completed', 'not ours');
    turnCompleted(h.bus, 'session-1', 'stopped', 'second');
    h.finishDelivery();
    await flush();
    const status = await handleBenchmarkSessionWebhook({ action: 'status', sessionId: 'session-1' }, h.deps);
    expect(status.data).toMatchObject({ terminal: true, status: 'stopped', turns: 2, finalOutput: 'second' });
  });

  it('reports a failed delivery as a failed terminal session', async () => {
    const h = harness();
    await handleBenchmarkSessionWebhook({
      action: 'start', message: 'task', productionBenchmarkEvidenceContext: CONTEXT,
    }, h.deps);
    h.finishDelivery(new Error('budget exhausted'));
    await flush();
    const status = await handleBenchmarkSessionWebhook({ action: 'status', sessionId: 'session-1' }, h.deps);
    expect(status.data).toMatchObject({
      running: false, terminal: true, status: 'failed', turns: 0, error: 'budget exhausted',
    });
  });

  it('gives a trial run exactly one session', async () => {
    const h = harness();
    const first = await handleBenchmarkSessionWebhook({
      action: 'start', message: 'task', productionBenchmarkEvidenceContext: CONTEXT,
    }, h.deps);
    expect(first.success).toBe(true);
    const second = await handleBenchmarkSessionWebhook({
      action: 'start', message: 'task', productionBenchmarkEvidenceContext: CONTEXT,
    }, h.deps);
    expect(second).toEqual({ success: false, error: 'trial run trial-1/root-1 already has a session' });
    expect(h.created).toHaveLength(1);

    const otherRun = await handleBenchmarkSessionWebhook({
      action: 'start', message: 'task',
      productionBenchmarkEvidenceContext: { ...CONTEXT, root_run_id: 'root-2' },
    }, h.deps);
    expect(otherRun.success).toBe(true);
  });

  it('refuses a start without a message or a valid context, and status for an unknown session', async () => {
    const h = harness();
    expect(await handleBenchmarkSessionWebhook({
      action: 'start', message: '  ', productionBenchmarkEvidenceContext: CONTEXT,
    }, h.deps)).toEqual({ success: false, error: 'message required' });
    const badContext = await handleBenchmarkSessionWebhook({
      action: 'start', message: 'task',
      productionBenchmarkEvidenceContext: { ...CONTEXT, trial_id: '' },
    }, h.deps);
    expect(badContext.success).toBe(false);
    expect(h.created).toEqual([]);
    expect(await handleBenchmarkSessionWebhook({ action: 'status', sessionId: 'session-9' }, h.deps))
      .toEqual({ success: false, error: 'not a benchmark session: session-9' });
  });
});
