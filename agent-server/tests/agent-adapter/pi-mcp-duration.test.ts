// input:  a trial deadline, PI abort signals and the resolved MCP composition
// output: proof of the PI MCP bridge's duration contract
// pos:    Regression suite for design §5.6 P1–P7
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Design §5.6 P1–P7: the PI MCP bridge's duration contract. The >60s HOLDING proof (T15) is a
// separate child's; what is proved here is the mechanism that makes it possible — the strict
// benchmark server set, explicit RequestOptions on every call, the grace constant, the
// progress-bounded reset, remaining time derived at the moment of use, and signal forwarding.

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

import {
  MCP_CLEANUP_GRACE_MS,
  MCP_PROGRESS_HEARTBEAT_MS,
  PI_BENCHMARK_DEADLINE_ENV,
  benchmarkCallOptions,
  remainingTrialMs,
} from '../../src/agent-adapter/pi/mcp-duration.js';
import {
  BENCHMARK_THREAD_SERVER_NAME,
  buildServerStates,
  installMcpBridge,
  type McpBridgeDeps,
  type McpClientHandle,
} from '../../src/agent-adapter/pi/mcp-bridge.js';
import { PI_MCP_COMPOSITION_ENV } from '../../src/agent-adapter/pi/policy-guard.js';
import type { ExtensionAPI, ToolDefinition } from '../../src/agent-adapter/pi/pi-ext-types.js';
import { startMcpProgressHeartbeat } from '../../src/domain/mcp/tools/benchmark-thread-run.js';

// ─── P3 / P7: the two fixed constants ───────────────────────────────

test('P3 cleanup grace is the supervisor grace plus the quiescence margin', () => {
  assert.equal(MCP_CLEANUP_GRACE_MS, 1_000 + 5_000);
});

test('P7 heartbeat is strictly below the SDK 60s reference window with beats to spare', () => {
  assert.equal(MCP_PROGRESS_HEARTBEAT_MS, 15_000);
  assert.ok(MCP_PROGRESS_HEARTBEAT_MS < 60_000);
  assert.equal(60_000 / MCP_PROGRESS_HEARTBEAT_MS, 4);
});

test('P7 the benchmark tool emits progress heartbeats only while its call is running', async () => {
  vi.useFakeTimers();
  try {
    const notifications: unknown[] = [];
    const stop = startMcpProgressHeartbeat({
      _meta: { progressToken: 'trial-progress' },
      sendNotification: async notification => { notifications.push(notification); },
    });
    await vi.advanceTimersByTimeAsync(MCP_PROGRESS_HEARTBEAT_MS);
    assert.deepEqual(notifications, [{
      method: 'notifications/progress',
      params: {
        progressToken: 'trial-progress', progress: 1, message: 'thread_run in progress',
      },
    }]);
    stop();
    await vi.advanceTimersByTimeAsync(MCP_PROGRESS_HEARTBEAT_MS);
    assert.equal(notifications.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

// The two predicates the heartbeat's own callers depend on and nothing exercised: a call with no
// progress token installs no timer at all, and a call that has one keeps beating with a strictly
// increasing `progress` for as long as it runs. Both run the PRODUCTION function — a duplicate that
// "mirrors the shape of" it proves nothing about it.
test('P7 a call with no progress token installs no heartbeat and still returns a disposer', async () => {
  vi.useFakeTimers();
  try {
    const notifications: unknown[] = [];
    const stop = startMcpProgressHeartbeat({
      sendNotification: async notification => { notifications.push(notification); },
    });
    await vi.advanceTimersByTimeAsync(MCP_PROGRESS_HEARTBEAT_MS * 4);
    assert.deepEqual(notifications, []);
    assert.equal(vi.getTimerCount(), 0);
    stop();
  } finally {
    vi.useRealTimers();
  }
});

test('P7 the heartbeat beats once per interval with a strictly increasing progress', async () => {
  vi.useFakeTimers();
  try {
    const beats: number[] = [];
    const stop = startMcpProgressHeartbeat({
      _meta: { progressToken: 7 },
      sendNotification: async notification => { beats.push(notification.params.progress); },
    });
    for (let interval = 0; interval < 5; interval += 1) {
      await vi.advanceTimersByTimeAsync(MCP_PROGRESS_HEARTBEAT_MS);
    }
    assert.deepEqual(beats, [1, 2, 3, 4, 5]);
    // Four beats land inside one SDK 60 s window, which is the property P7 exists to give.
    assert.ok(beats.length > 60_000 / MCP_PROGRESS_HEARTBEAT_MS);

    stop();
    await vi.advanceTimersByTimeAsync(MCP_PROGRESS_HEARTBEAT_MS * 3);
    assert.deepEqual(beats, [1, 2, 3, 4, 5]);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

// ─── P5: remaining time derived at the moment of use ────────────────

test('P5 remaining time is recomputed from the absolute deadline on every read', () => {
  const env = { [PI_BENCHMARK_DEADLINE_ENV]: '10000' };
  assert.equal(remainingTrialMs(env, 1_000), 9_000);
  assert.equal(remainingTrialMs(env, 7_500), 2_500);
  // Past the deadline the budget floors at zero rather than going negative.
  assert.equal(remainingTrialMs(env, 12_000), 0);
});

test('P5 an absent or unusable deadline yields no budget rather than a fabricated one', () => {
  assert.equal(remainingTrialMs({}, 1_000), null);
  assert.equal(remainingTrialMs({ [PI_BENCHMARK_DEADLINE_ENV]: '' }, 1_000), null);
  assert.equal(remainingTrialMs({ [PI_BENCHMARK_DEADLINE_ENV]: 'soon' }, 1_000), null);
});

// ─── P2 / P4 / P6: the explicit options every benchmark call carries ─

test('P2 timeout and maxTotalTimeout are both remaining + grace, with progress reset on', () => {
  const options = benchmarkCallOptions(30_000);
  assert.equal(options.timeout, 30_000 + MCP_CLEANUP_GRACE_MS);
  assert.equal(options.maxTotalTimeout, 30_000 + MCP_CLEANUP_GRACE_MS);
  assert.equal(options.resetTimeoutOnProgress, true);
});

test('P2 a long remaining budget produces a timeout far past the SDK 60s default', () => {
  assert.ok((benchmarkCallOptions(600_000).timeout ?? 0) > 60_000);
});

test('P4 maxTotalTimeout equals timeout, so progress resets cannot extend the call', () => {
  for (const remaining of [0, 1, 59_000, 3_600_000]) {
    const options = benchmarkCallOptions(remaining);
    assert.equal(options.maxTotalTimeout, options.timeout);
    assert.equal(options.maxTotalTimeout, remaining + MCP_CLEANUP_GRACE_MS);
  }
});

test('P6 the abort signal and progress callback are forwarded when supplied', () => {
  const controller = new AbortController();
  const onprogress = (): void => {};
  const options = benchmarkCallOptions(1_000, controller.signal, onprogress);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.onprogress, onprogress);
});

// ─── P1: the strict benchmark server set ────────────────────────────

test('P1 benchmark-thread-run yields exactly the cortex-benchmark-thread server', () => {
  const states = buildServerStates({ [PI_MCP_COMPOSITION_ENV]: 'benchmark-thread-run' });
  assert.deepEqual(states.map(s => s.name), [BENCHMARK_THREAD_SERVER_NAME]);
});

test('P1 none yields zero servers', () => {
  assert.deepEqual(buildServerStates({ [PI_MCP_COMPOSITION_ENV]: 'none' }), []);
});

test('P1 the strict set ignores every ambient server switch', () => {
  const states = buildServerStates({
    [PI_MCP_COMPOSITION_ENV]: 'benchmark-thread-run',
    CORTEX_THREAD_ID: 'thr_ambient',
    SLACK_CHANNEL: 'C123',
  });
  assert.deepEqual(states.map(s => s.name), [BENCHMARK_THREAD_SERVER_NAME]);
});

test('an unrestricted composition keeps the shipped daemon server set', () => {
  const names = buildServerStates({ [PI_MCP_COMPOSITION_ENV]: 'direct' }).map(s => s.name);
  assert.deepEqual(names, ['core', 'tasks', 'manager-qa', 'ext']);
});

// ─── The far side of the seam: the registered tool actually calls through ─

interface RecordedCall {
  name: string;
  options: Record<string, unknown> | undefined;
}

function fakeBridge(env: NodeJS.ProcessEnv): {
  pi: ExtensionAPI;
  calls: RecordedCall[];
  tools: Map<string, ToolDefinition>;
  start(): Promise<void>;
} {
  const calls: RecordedCall[] = [];
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const handle: McpClientHandle = {
    client: {
      listTools: async () => ({ tools: [{ name: 'thread_run', description: 'run', inputSchema: { type: 'object' } }] }),
      callTool: async (params: any, _schema: unknown, options: any) => {
        calls.push({ name: params.name, options });
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    } as unknown as McpClientHandle['client'],
    transport: { close: async () => {} },
  };
  const pi = {
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => { handlers.set(event, handler); },
    registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
  } as unknown as ExtensionAPI;
  const deps: McpBridgeDeps = {
    env,
    spawnClient: async () => handle,
    reportFailure: (error) => { throw error; },
  };
  return {
    pi,
    calls,
    tools,
    start: async () => {
      await installMcpBridge(pi, deps);
      await handlers.get('before_agent_start')!({}, {});
    },
  };
}

test('P2/P6 the registered benchmark tool passes explicit options through to callTool', async () => {
  const bridge = fakeBridge({
    [PI_MCP_COMPOSITION_ENV]: 'benchmark-thread-run',
    [PI_BENCHMARK_DEADLINE_ENV]: String(Date.now() + 900_000),
  });
  await bridge.start();

  const tool = bridge.tools.get('thread_run');
  assert.ok(tool, 'the bridge registered the composition tool unprefixed');
  const controller = new AbortController();
  await tool.execute('call-1', {}, controller.signal, undefined, {} as never);

  assert.equal(bridge.calls.length, 1);
  const options = bridge.calls[0].options as Record<string, unknown>;
  assert.equal(options.resetTimeoutOnProgress, true);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.timeout, options.maxTotalTimeout);
  assert.ok((options.timeout as number) > 60_000, 'the SDK 60s default is not the ceiling');
});

test('P5 two calls on the same tool derive their budgets independently', async () => {
  const bridge = fakeBridge({
    [PI_MCP_COMPOSITION_ENV]: 'benchmark-thread-run',
    [PI_BENCHMARK_DEADLINE_ENV]: String(Date.now() + 900_000),
  });
  await bridge.start();
  const tool = bridge.tools.get('thread_run')!;

  await tool.execute('call-1', {}, undefined, undefined, {} as never);
  await new Promise(resolve => setTimeout(resolve, 12));
  await tool.execute('call-2', {}, undefined, undefined, {} as never);

  const first = bridge.calls[0].options as Record<string, number>;
  const second = bridge.calls[1].options as Record<string, number>;
  assert.ok(second.timeout < first.timeout, 'the second budget shrank with elapsed time');
});

test('a daemon call without a trial deadline carries no fabricated timeout', async () => {
  const bridge = fakeBridge({ [PI_MCP_COMPOSITION_ENV]: 'direct' });
  await bridge.start();
  const tool = bridge.tools.get('thread_run')!;
  await tool.execute('call-1', {}, undefined, undefined, {} as never);

  const options = bridge.calls[0].options as Record<string, unknown>;
  assert.equal(options.timeout, undefined);
  assert.equal(options.maxTotalTimeout, undefined);
});
