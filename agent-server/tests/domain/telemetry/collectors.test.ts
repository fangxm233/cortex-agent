import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { configureRollupStore, persistRollup } from '@domain/telemetry/rollup.js';
import { rollupFile } from '@domain/telemetry/paths.js';
import { createRunTelemetry, classifyTurnFailure } from '@domain/telemetry/turns.js';
import {
  markBootPhase, recordStartup, recordUiMutation, recordWebhookCall, installWebReportSink, platformChannel,
} from '@domain/telemetry/usage.js';
import { recordWebReport, setWebReportSink } from '@domain/telemetry/web-report.js';
import { recordFunnelStep, resetFunnelCacheForTests } from '@domain/telemetry/funnel.js';
import { takeOutbox } from '@domain/telemetry/outbox.js';
import { updateTelemetryState } from '@domain/telemetry/state.js';
import { wipeLocalTelemetry } from '@domain/telemetry/service.js';
import type { RunRequest } from '@domain/runs/request.js';
import { enableTelemetryForTest } from './helpers.js';

let restore: () => void = () => {};
let dir = '';
const NOW = Date.parse('2026-10-01T12:00:00Z');
beforeEach(() => {
  restore = enableTelemetryForTest();
  dir = mkdtempSync(path.join(os.tmpdir(), 'telemetry-collect-'));
  configureRollupStore({ dir, now: () => NOW });
  resetFunnelCacheForTests();
});
afterEach(() => {
  configureRollupStore({});
  setWebReportSink(null);
  wipeLocalTelemetry();
  updateTelemetryState(() => ({ lastHeartbeatAt: null, lastVersion: null, funnelSent: [], pendingUpgrade: null }));
  restore();
});

function rollup() {
  persistRollup();
  return JSON.parse(readFileSync(rollupFile('2026-10-01', dir), 'utf8'));
}

function request(overrides: Partial<RunRequest['context']> = {}, sessionId: string | null = 'sess-1'): RunRequest {
  return {
    session: { sessionId },
    selection: { backend: 'claude', provider: null, model: 'claude-opus-4-7', thinking: null, mode: 'plan' },
    context: { channel: 'web:x', project: 'p', trigger: 'user', executionKind: 'local', isUserInitiated: true, ...overrides },
  } as unknown as RunRequest;
}

test('a run folds into its turn row, tools, tokens and session turn count', () => {
  const run = createRunTelemetry(request());
  run.observer.onEvent({ type: 'assistant_delta', text: 'hi', blockId: 'b', phase: 'foreground' });
  run.observer.onEvent({ type: 'tool_use', toolUseId: 't1', name: 'Bash', input: {}, phase: 'foreground' });
  run.observer.onEvent({ type: 'tool_result', toolUseId: 't1', ok: false, content: 'x', phase: 'foreground' });
  run.observer.onEvent({ type: 'context_usage', usedTokens: 1, contextWindow: 2, percent: 60, accuracy: 'exact', phase: 'foreground' });
  run.observer.onEvent({ type: 'context_compacted', trigger: 'auto', phase: 'foreground' });
  run.observer.onEvent({
    type: 'cost_record', provider: 'anthropic', model: 'm', tokens_in: null, tokens_out: null,
    input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_creation_tokens: 1, provider_requests: 1, cost_usd: 0,
  });
  run.finish({ status: 'completed', durationS: 42 });
  run.finish({ status: 'completed', durationS: 42 });
  const data = rollup();
  const row = data.turns['claude||claude-opus-4-7|plan'];
  assert.deepEqual(row.outcomes, { completed: 1, failed: 0, cancelled: 0, rateLimited: 0 });
  assert.equal(row.ttftMs.reduce((a: number, b: number) => a + b, 0), 1);
  assert.equal(row.durationS[3], 1, '42 s lands in the <=60 bucket');
  assert.equal(row.contextPctAtEnd[3], 1, '60% lands in the <=75 bucket');
  assert.deepEqual(row.compactions, { auto: 1, manual: 0 });
  assert.deepEqual(row.tokens, { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 });
  assert.deepEqual(data.tools.Bash, { calls: 1, errors: 1 });
  assert.equal(data.agent.sessionTurns['sess-1'], 1);
  const funnel = takeOutbox().map((event) => (event as { step?: string }).step);
  assert.deepEqual(funnel, ['provider_authed', 'first_turn_completed']);
});

test('failures are classified; user cancels and supersedes are counted; worker and subagent outcomes kept', () => {
  createRunTelemetry(request()).finish({ status: 'failed', durationS: 1, error: new Error('401 invalid x-api-key') });
  createRunTelemetry(request()).finish({ status: 'failed', durationS: 1, error: new Error('fetch failed ECONNRESET') });
  createRunTelemetry(request()).finish({ status: 'cancelled', durationS: 1, error: new Error('Run cancelled (user)') });
  createRunTelemetry(request()).finish({ status: 'cancelled', durationS: 1, error: new Error('Run cancelled (supersede)') });
  createRunTelemetry(request({ teamWorker: true })).finish({ status: 'completed', durationS: 1 });
  createRunTelemetry(request({ trigger: 'subagent' }, null)).finish({ status: 'failed', durationS: 1 });
  createRunTelemetry(request({ trigger: 'cache-refresh' })).finish({ status: 'completed', durationS: 1 });
  const data = rollup();
  const row = data.turns['claude||claude-opus-4-7|plan'];
  assert.deepEqual(row.failures, { auth: 1, network: 1 });
  assert.equal(row.outcomes.cancelled, 2);
  assert.equal(row.outcomes.completed, 1, 'cache refresh is not a turn; the worker turn is');
  assert.equal(data.agent.userInterrupts, 1);
  assert.equal(data.agent.superseded, 1);
  assert.deepEqual(data.agent.workers, { completed: 1, failed: 0, cancelled: 0 });
  assert.deepEqual(data.agent.subagents, { completed: 0, failed: 1, cancelled: 0 });
  assert.equal(classifyTurnFailure('Request timed out'), 'timeout');
  assert.equal(classifyTurnFailure('claude exited with code 1'), 'adapter_crash');
  assert.equal(classifyTurnFailure('429 Too Many Requests'), 'rate_limit');
  assert.equal(classifyTurnFailure('something odd'), 'other');
});

test('UI ops, messages by app, webhook features and browser leases', () => {
  recordUiMutation('sessions.send', true, 'android');
  recordUiMutation('sessions.send', true, null);
  recordUiMutation('sessions.createAndSend', true, 'desktop');
  recordUiMutation('sessions.send', false, 'desktop');
  recordWebhookCall('/webhook/team', { action: 'spawn' });
  recordWebhookCall('/webhook/team', { action: 'list' });
  recordWebhookCall('/webhook/board', { action: 'open' });
  recordWebhookCall('/webhook/browser', { action: 'lease', sessionId: 'a' });
  recordWebhookCall('/webhook/browser', { action: 'lease', sessionId: 'a' });
  recordWebhookCall('/webhook/browser', { action: 'lease', sessionId: 'b' });
  const data = rollup();
  assert.deepEqual(data.uiOps, { 'sessions.send': 3, 'sessions.createAndSend': 1 });
  assert.deepEqual(data.messagesByChannel, { android: 1, other: 1, desktop: 1 });
  assert.deepEqual(data.features, { session_created: 1, worker_spawned: 1, board_opened: 1, browser_session: 2 });
  assert.equal(platformChannel('slack:C1'), 'slack');
  assert.equal(platformChannel('tui-abc'), 'tui');
});

test('boot phases and web reports land in perf; web crashes become crash events', () => {
  markBootPhase('migrations', 150);
  markBootPhase('scheduler', 400);
  recordStartup(100, 500);
  installWebReportSink();
  recordWebReport({ kind: 'load', ttfbMs: 120, firstRenderMs: 800, interactiveMs: null }, 'browser');
  recordWebReport({ kind: 'sse_reconnect', count: 3 }, 'desktop');
  recordWebReport({
    kind: 'crash', crashKind: 'renderError', errorName: 'TypeError', message: `bad ${os.homedir()}`,
    stack: 'TypeError: x\n    at Ab (https://cortex.private.example/assets/index-Bx.js:1:2)',
    route: '/session/:id', buildStamp: 'abc', uptimeS: 3,
  }, 'desktop');
  const data = rollup();
  assert.deepEqual(data.perf.startups, [{ imports: 100, migrations: 50, scheduler: 250, total: 500 }]);
  assert.equal(data.perf.web.loads, 1);
  assert.equal(data.perf.web.ttfbMs[0], 1);
  assert.equal(data.perf.web.firstRenderMs[2], 1);
  assert.equal(data.perf.sseReconnects, 3);
  const [crash] = takeOutbox() as Array<Record<string, unknown>>;
  assert.equal(crash.component, 'web');
  assert.equal(crash.client, 'desktop');
  assert.equal(crash.route, '/session/:id');
  assert.equal(crash.groupKey, 'TypeError@/assets/index-Bx.js');
  assert.doesNotMatch(JSON.stringify(crash), /private\.example|\/home\//);
});

test('funnel steps are sent once per install', () => {
  recordFunnelStep('first_worker');
  resetFunnelCacheForTests();
  recordFunnelStep('first_worker');
  assert.equal(takeOutbox().length, 1);
});
