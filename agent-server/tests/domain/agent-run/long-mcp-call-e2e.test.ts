// input:  a real stdio MCP server holding one call, the PI bridge and a supervised Claude trial
// output: wall-clock proof that a benchmark MCP call outlives 60 s and stays bounded
// pos:    Independent Gate-2 proving suite for design §13 (13.6) T15
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Design §13 (13.6) T15, against §5.6 P1–P7 (PI) and §5.7 C1–C6 (Claude). These are holding tests,
// not option-shape tests: the SDK client, the stdio transport, the server process and the clock are
// all real, and only the tool body is faked. A backend that silently kept the SDK's 60 000 ms
// default fails here by timing out, which is exactly the orphaned-thread outcome the contract bars.
// The option shapes themselves are already covered by tests/agent-adapter/pi-mcp-duration.test.ts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  installMcpBridge, type McpBridgeDeps, type McpClientHandle,
} from '../../../src/agent-adapter/pi/mcp-bridge.js';
import {
  MCP_CLEANUP_GRACE_MS, PI_BENCHMARK_DEADLINE_ENV,
} from '../../../src/agent-adapter/pi/mcp-duration.js';
import { PI_MCP_COMPOSITION_ENV } from '../../../src/agent-adapter/pi/policy-guard.js';
import type { ExtensionAPI, ToolDefinition } from '../../../src/agent-adapter/pi/pi-ext-types.js';
import {
  SDK_DEFAULT_TIMEOUT_MS, buildSupervisor, claudeTrial, holdServerArgs, readJson, runTrial,
  waitForExit, waitForFile, type HoldServerOptions,
} from './long-mcp-trial-fixture.js';

/** Long enough that finishing proves the 60 s default did not decide the call. */
const HOLD_PAST_DEFAULT_MS = 63_000;

let root = '';
const openTransports: Array<{ close(): Promise<void> }> = [];

beforeAll(buildSupervisor, 120_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'long-mcp-'));
});

afterEach(async () => {
  for (const transport of openTransports.splice(0)) await transport.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

// ─── PI: the MCP client is Cortex's own bridge, so the whole path is production code ───

interface PiBridge {
  tools: Map<string, ToolDefinition>;
  serverPid(): number;
  abortedFile: string;
  start(): Promise<void>;
}

function piBridge(env: NodeJS.ProcessEnv, options: HoldServerOptions): PiBridge {
  const server = holdServerArgs(root, options);
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => { handlers.set(event, handler); },
    registerTool: (definition: ToolDefinition) => { tools.set(definition.name, definition); },
  } as unknown as ExtensionAPI;
  const deps: McpBridgeDeps = {
    env,
    // The one dependency the bridge takes by injection. Everything past it — the SDK client, the
    // stdio transport, the child process — is the same machinery the daemon path uses.
    spawnClient: async (): Promise<McpClientHandle> => {
      const transport = new StdioClientTransport({ command: process.execPath, args: server.args });
      const client = new Client({ name: 'long-mcp-pi-bridge', version: '0.0.0-fixture' });
      await client.connect(transport);
      openTransports.push(transport);
      return { client, transport };
    },
    reportFailure: (error) => { throw error; },
  };
  return {
    tools,
    serverPid: () => readJson(server.pidFile).pid as number,
    abortedFile: server.abortedFile,
    start: async () => {
      await installMcpBridge(pi, deps);
      await handlers.get('before_agent_start')!({}, {});
    },
  };
}

function trialEnv(remainingMs: number): NodeJS.ProcessEnv {
  return {
    [PI_MCP_COMPOSITION_ENV]: 'benchmark-thread-run',
    [PI_BENCHMARK_DEADLINE_ENV]: String(Date.now() + remainingMs),
  };
}

it('holds a real PI MCP call past the SDK 60 s default while a default-options client is cut (T15)', async () => {
  const bridge = piBridge(trialEnv(600_000), { holdMs: HOLD_PAST_DEFAULT_MS, name: 'pi-long' });
  await bridge.start();
  const tool = bridge.tools.get('thread_run');
  assert.ok(tool, 'the bridge registered the composition tool');

  // The control runs against a second server process with no explicit options, so the difference
  // between the two outcomes is the RequestOptions the production bridge supplied and nothing else.
  const control = holdServerArgs(root, { holdMs: HOLD_PAST_DEFAULT_MS, name: 'pi-control' });
  const controlTransport = new StdioClientTransport({ command: process.execPath, args: control.args });
  const controlClient = new Client({ name: 'long-mcp-control', version: '0.0.0-fixture' });
  await controlClient.connect(controlTransport);
  openTransports.push(controlTransport);

  const startedAt = Date.now();
  const [held, cut] = await Promise.all([
    tool.execute('call-1', {}, undefined, undefined, {} as never)
      .then(value => ({ ok: true as const, value, elapsedMs: Date.now() - startedAt }))
      .catch(error => ({ ok: false as const, error, elapsedMs: Date.now() - startedAt })),
    controlClient.callTool({ name: 'thread_run', arguments: {} })
      .then(value => ({ ok: true as const, value, elapsedMs: Date.now() - startedAt }))
      .catch(error => ({ ok: false as const, error, elapsedMs: Date.now() - startedAt })),
  ]);

  assert.equal(held.ok, true, `bridge call failed: ${String((held as any).error)}`);
  assert.ok(
    held.elapsedMs > SDK_DEFAULT_TIMEOUT_MS,
    `the bridge call returned after ${held.elapsedMs}ms, which does not clear the 60 s default`,
  );
  assert.equal((held as any).value.details.isError, false);
  // The control proves the default is a real ceiling here, not a hypothetical one.
  assert.equal(cut.ok, false, 'a default-options client somehow survived the 60 s SDK timeout');
  assert.ok(
    cut.elapsedMs < HOLD_PAST_DEFAULT_MS,
    `the control call was not cut before the hold ended (${cut.elapsedMs}ms)`,
  );
}, 115_000);

it('bounds a PI MCP call at deadline + grace even while progress keeps resetting it (T15)', async () => {
  const remainingMs = 1_500;
  const budgetMs = remainingMs + MCP_CLEANUP_GRACE_MS;
  const bridge = piBridge(trialEnv(remainingMs), {
    // The hold outlasts the budget by a wide margin, and the progress interval is short enough that
    // `resetTimeoutOnProgress` fires many times before the bound lands (§5.6 P4).
    holdMs: 90_000, progressMs: 300, name: 'pi-bounded',
  });
  await bridge.start();
  const tool = bridge.tools.get('thread_run')!;
  const serverPid = bridge.serverPid();

  const startedAt = Date.now();
  await assert.rejects(
    tool.execute('call-1', {}, undefined, undefined, {} as never),
    'a call whose budget expired resolved instead of failing',
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs >= budgetMs - 1_000 && elapsedMs < 30_000,
    `the call ended after ${elapsedMs}ms, not near the ${budgetMs}ms bound`,
  );

  // §5.7 C5 (iii): the abort leaves nothing running. Closing the client transport is the only
  // teardown the bridge performs, so a server that survives it is an orphan.
  for (const transport of openTransports.splice(0)) await transport.close().catch(() => {});
  await waitForExit(serverPid);
}, 115_000);

it('forwards a PI cancellation into the in-flight MCP request rather than orphaning it (T15)', async () => {
  const bridge = piBridge(trialEnv(600_000), { holdMs: 90_000, name: 'pi-cancel' });
  await bridge.start();
  const tool = bridge.tools.get('thread_run')!;
  const controller = new AbortController();

  const call = tool.execute('call-1', {}, controller.signal, undefined, {} as never);
  await delay(500);
  controller.abort(new Error('pi cancelled the tool'));
  await assert.rejects(call, 'an aborted call resolved instead of failing');

  // §5.6 P6: the server side observed the cancellation, so the hold was released rather than left
  // running behind a caller that has already given up.
  await waitForFile(bridge.abortedFile, 10_000);
}, 60_000);

// ─── Claude: the CLI owns the MCP client, so what is provable here is the budget Cortex supplies ──

it('holds a real Claude-side MCP call past 60 s and leaves no server behind (T15)', async () => {
  const trial = claudeTrial(root, {
    hold: { holdMs: HOLD_PAST_DEFAULT_MS, name: 'claude-long' }, deadlineSeconds: 600,
  });
  const outcome = await runTrial(trial);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'completed');

  const call = readJson(trial.mcpResult);
  assert.equal(call.ok, true, `the held call failed: ${call.error}`);
  assert.ok(
    call.elapsedMs > SDK_DEFAULT_TIMEOUT_MS,
    `the call returned after ${call.elapsedMs}ms, which does not clear the 60 s default`,
  );
  assert.equal(JSON.parse(call.text).outcome, 'held');
  // §5.7 C5 (iii): the sidecar the CLI spawned is inside the supervised tree and does not outlive it.
  assert.equal(outcome.terminal.manifest.supervisor.quiescent, true);
  await waitForExit(readJson(trial.server.pidFile).pid as number);
}, 115_000);

// ─── §5.7 C3 has landed on the Claude path — the row below is a live predicate ─────────────────
//
// This row was committed as `it.fails`: the blocker was that nothing in `agent-server/src` wrote
// `MCP_TOOL_TIMEOUT` or `MCP_TIMEOUT`, so `benchmarkDeadlineEpochMs` (set at
// `trial-adapter-factory.ts:167`) reached PI and was dropped by the Claude path, leaving the child
// on the CLI's unset default (1e8 ms) — past 60 s, as the row above proves, but unbounded by the
// trial deadline, which is the other half of what `benchmark-long-mcp-call` asserts.
//
// `d319135a` closed it: `buildClaudeEnv` takes the absolute deadline and derives both variables at
// the moment the child environment is built, valued at remaining trial time plus the same cleanup
// grace PI uses. The assertions below are unchanged from the blocking version — they are the
// oracle that fixed the shape of the fix, not a description written after it.
it('supplies the Claude child a per-call MCP budget bounded by the trial deadline (T15, §5.7 C3)', async () => {
  const trial = claudeTrial(root, {
    hold: { holdMs: 200, name: 'claude-budget' }, deadlineSeconds: 600,
  });
  const outcome = await runTrial(trial);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);

  const { env } = readJson(trial.observation) as { env: Record<string, string> };
  // §5.7 C3 names both variables: the per-call budget and the server-startup budget. Without them
  // the child runs on the CLI's unset default (1e8 ms), which clears 60 s but is not bounded by the
  // trial deadline — the second half of what C1's capability declaration asserts.
  assert.ok(env.MCP_TOOL_TIMEOUT, 'the trial supplied no MCP_TOOL_TIMEOUT to the Claude child');
  assert.ok(env.MCP_TIMEOUT, 'the trial supplied no MCP_TIMEOUT to the Claude child');

  // §5.7 C3 / §5.6 P2: the same quantity on both backends — remaining trial time plus cleanup
  // grace, derived at the moment of use, so it tracks the deadline rather than the arm's length.
  const budgetMs = Number(env.MCP_TOOL_TIMEOUT);
  const remainingMs = trial.policy.deadline.absolute_epoch_ms - Date.now();
  assert.ok(
    budgetMs > SDK_DEFAULT_TIMEOUT_MS,
    `the supplied budget ${budgetMs}ms does not clear the native 60 s reference window`,
  );
  assert.ok(
    budgetMs <= remainingMs + MCP_CLEANUP_GRACE_MS + 5_000,
    `the supplied budget ${budgetMs}ms is not bounded by the trial deadline`,
  );
}, 115_000);
