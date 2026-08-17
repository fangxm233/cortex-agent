// input:  Claude usage collector and fake control-protocol processes
// output: Correlation, normalization, failure, and cleanup tests
// pos:    Claude account-usage adapter boundary regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test, vi } from 'vitest';
import { ClaudeAdapter } from '../../src/agent-adapter/claude/adapter.js';
import {
  CLAUDE_USAGE_TIMEOUT_MS,
  collectClaudeUsage,
  type ClaudeUsageProcess,
  type ClaudeUsageSpawn,
} from '../../src/agent-adapter/claude/usage.js';

class FakeUsageProcess extends EventEmitter implements ClaudeUsageProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    this.signalCode = signal;
    return true;
  }
}

function harness() {
  const child = new FakeUsageProcess();
  const calls: Array<{
    command: string;
    args: string[];
    options: { cwd: string; env: NodeJS.ProcessEnv };
  }> = [];
  const spawn: ClaudeUsageSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { child, calls, spawn };
}

function controlResponse(requestId: string, response: unknown): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  }) + '\n';
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('correlates get_usage response and normalizes scoped account windows', async () => {
  const { child, calls, spawn } = harness();
  let written = '';
  child.stdin.on('data', (chunk) => { written += chunk.toString(); });
  const pending = collectClaudeUsage(
    { provider: 'anthropic', mode: 'plan' },
    { spawn, requestId: () => 'usage-request', now: () => 1_723_456_789_123 },
  );
  await nextTick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'claude');
  assert.ok(calls[0].args.includes('-p'));
  assert.ok(calls[0].args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(written.trim()), {
    type: 'control_request',
    request_id: 'usage-request',
    request: { subtype: 'get_usage' },
  });

  child.stdout.write(controlResponse('other-request', { rate_limits: {} }));
  child.stdout.write(controlResponse('usage-request', {
    rate_limits: {
      five_hour: { utilization: 34, resets_at: '2026-08-16T12:00:00.000Z' },
      tangelo: { utilization: 12.5, resets_at: '2026-08-17T00:00:00.000Z' },
      model_scoped: [
        { display_name: 'Fable', utilization: 33, resets_at: '2026-08-20T00:00:00.000Z' },
        { display_name: 'Unlisted Model', utilization: null, resets_at: null },
      ],
      extra_usage: { is_enabled: true, utilization: 90 },
    },
  }));

  assert.deepEqual(await pending, [{
    provider: 'anthropic',
    displayName: 'Anthropic',
    modes: ['plan'],
    windows: [
      {
        type: 'five_hour',
        utilization: 0.34,
        resetsAt: Date.parse('2026-08-16T12:00:00.000Z') / 1000,
      },
      {
        type: 'tangelo',
        utilization: 0.125,
        resetsAt: Date.parse('2026-08-17T00:00:00.000Z') / 1000,
      },
      {
        type: 'model_scoped',
        label: 'Fable',
        utilization: 0.33,
        resetsAt: Date.parse('2026-08-20T00:00:00.000Z') / 1000,
      },
      {
        type: 'model_scoped',
        label: 'Unlisted Model',
        utilization: null,
        resetsAt: null,
      },
    ],
    observedAt: 1_723_456_789,
    freshness: 'live',
  }]);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});

test('tolerates non-window rate_limits entries and keeps only informative windows', async () => {
  const { child, spawn } = harness();
  const pending = collectClaudeUsage(
    { provider: 'anthropic', mode: 'plan' },
    { spawn, requestId: () => 'usage-open-set', now: () => 1_723_456_789_123 },
  );
  child.stdout.write(controlResponse('usage-open-set', {
    rate_limits: {
      five_hour: {
        utilization: 42,
        resets_at: '2026-08-16T12:00:00.000Z',
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      seven_day: { utilization: 18, resets_at: '2026-08-21T00:00:00.000Z' },
      seven_day_alpha: null,
      seven_day_beta: null,
      alpha_bucket: null,
      beta_bucket: null,
      gamma_bucket: { utilization: 0, resets_at: null, limit_dollars: null },
      delta_bucket: { utilization: null, resets_at: null, limit_dollars: null },
      limits: [
        { kind: 'session', group: 'session', percent: 42, severity: 'normal', is_active: true },
      ],
      spend: { used: { amount_minor: 0, currency: 'USD' }, percent: 0, enabled: false },
      member_dashboard_available: false,
      extra_usage: { is_enabled: false, utilization: null, daily: null, weekly: null },
      model_scoped: [
        { display_name: 'Alpha Model', utilization: 27, resets_at: '2026-08-21T00:00:00.000Z' },
      ],
    },
  }));

  assert.deepEqual(await pending, [{
    provider: 'anthropic',
    displayName: 'Anthropic',
    modes: ['plan'],
    windows: [
      {
        type: 'five_hour',
        utilization: 0.42,
        resetsAt: Date.parse('2026-08-16T12:00:00.000Z') / 1000,
      },
      {
        type: 'seven_day',
        utilization: 0.18,
        resetsAt: Date.parse('2026-08-21T00:00:00.000Z') / 1000,
      },
      { type: 'gamma_bucket', utilization: 0, resetsAt: null },
      {
        type: 'model_scoped',
        label: 'Alpha Model',
        utilization: 0.27,
        resetsAt: Date.parse('2026-08-21T00:00:00.000Z') / 1000,
      },
    ],
    observedAt: 1_723_456_789,
    freshness: 'live',
  }]);
});

test('adapter usage pull bypasses conversational print and TUI session spawn paths', async () => {
  const scopes: unknown[] = [];
  const adapter = new ClaudeAdapter(async (scope) => {
    scopes.push(scope);
    return null;
  });
  const spawnSession = vi.spyOn(adapter, 'spawn');

  assert.equal(await adapter.getUsage({ provider: 'anthropic', mode: 'plan' }), null);
  assert.deepEqual(scopes, [{ provider: 'anthropic', mode: 'plan' }]);
  assert.equal(spawnSession.mock.calls.length, 0);
});

test('does not collect or attribute account usage without a complete requested scope', async () => {
  const { calls, spawn } = harness();

  assert.equal(await collectClaudeUsage({}, { spawn }), null);
  assert.equal(await collectClaudeUsage({ provider: 'anthropic' }, { spawn }), null);
  assert.equal(await collectClaudeUsage({ mode: 'plan' }, { spawn }), null);
  assert.equal(calls.length, 0);
});

test('surfaces correlated Claude control errors and cleans up the process', async () => {
  const { child, spawn } = harness();
  const pending = collectClaudeUsage(
    { provider: 'anthropic', mode: 'plan' },
    { spawn, requestId: () => 'usage-error' },
  );
  child.stdout.write(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: 'usage-error', error: 'usage endpoint denied' },
  }) + '\n');

  await assert.rejects(pending, /usage endpoint denied/);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});

test('cleans up when writing the control request throws synchronously', async () => {
  const { child, spawn } = harness();
  child.stdin.write = (() => { throw new Error('stdin write failed'); }) as typeof child.stdin.write;

  const pending = collectClaudeUsage(
    { provider: 'anthropic', mode: 'plan' },
    { spawn, requestId: () => 'usage-write-throw' },
  );

  await assert.rejects(pending, /stdin write failed/);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});

test('surfaces stdin pipe errors and cleans up the process', async () => {
  const { child, spawn } = harness();
  const pending = collectClaudeUsage(
    { provider: 'anthropic', mode: 'plan' },
    { spawn, requestId: () => 'usage-stdin-error' },
  );

  child.stdin.emit('error', new Error('stdin pipe failed'));

  await assert.rejects(pending, /stdin pipe failed/);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});

test('surfaces malformed correlated responses and early process exits', async () => {
  const malformedHarness = harness();
  const malformed = collectClaudeUsage(
    { provider: 'anthropic', mode: 'plan' },
    { spawn: malformedHarness.spawn, requestId: () => 'usage-malformed' },
  );
  malformedHarness.child.stdout.write(controlResponse('usage-malformed', {
    rate_limits: { five_hour: { utilization: '34', resets_at: null } },
  }));
  await assert.rejects(malformed, /malformed.*utilization/i);
  assert.deepEqual(malformedHarness.child.killSignals, ['SIGKILL']);

  const exitHarness = harness();
  const exited = collectClaudeUsage(
    { provider: 'anthropic', mode: 'plan' },
    { spawn: exitHarness.spawn, requestId: () => 'usage-exit' },
  );
  exitHarness.child.stderr.write('credential unavailable');
  exitHarness.child.emit('close', 1, null);
  await assert.rejects(exited, /credential unavailable/);
  assert.deepEqual(exitHarness.child.killSignals, ['SIGKILL']);
});

test('bounds process lifetime and surfaces timeout for service downgrade', async (t) => {
  vi.useFakeTimers();
  t.onTestFinished(() => { vi.useRealTimers(); });
  const { child, spawn } = harness();
  const pending = collectClaudeUsage(
    { provider: 'anthropic', mode: 'plan' },
    { spawn, requestId: () => 'usage-timeout' },
  );

  vi.advanceTimersByTime(CLAUDE_USAGE_TIMEOUT_MS - 1);
  assert.deepEqual(child.killSignals, []);
  vi.advanceTimersByTime(1);
  await assert.rejects(pending, /timed out/i);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});
