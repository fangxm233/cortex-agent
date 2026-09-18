// input:  the bundled `agent` / `agent_stop` MCP tools and the leaf guards around them
// output: registration shape, webhook proxy payloads, foreground polling, child-is-a-leaf checks,
//         catalog-driven field descriptions
// pos:    Tests the MCP delegation surface

import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { z } from 'zod';
import {
  MCP_TOOLS_BY_SERVER, SUBAGENT_TOOLS, withoutSubagentTools,
} from '../src/core/mcp-tool-gate.js';
import { registerGatedMcpTools } from '../src/core/mcp-tool-gate.js';
import { buildSpawnArgs } from '../src/agent-adapter/claude/spawn-args.js';
import {
  DEFAULT_TOOLS, MCP_CONFIG, subagentBridgeTools,
} from '../src/agent-adapter/claude/defaults.js';
import type { CortexToolContext } from '../src/domain/mcp/tools/context.js';

const requestLoopbackJson = vi.hoisted(() => vi.fn());
vi.mock('../src/core/loopback-http.js', () => ({ requestLoopbackJson }));
const {
  registerSubagentTools, CLIENT_IDLE_FLOOR_MS, FOREGROUND_DEADLINE_MS, WAIT_REQUEST_TIMEOUT_MS,
} = await import('../src/domain/mcp/tools/subagent.js');

// --- a minimal McpServer stand-in ---

interface Registered {
  name: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  handler: (params: any, extra?: any) => Promise<any>;
}

function registerTools(
  allowlist: ReadonlySet<string> | null = null,
  context: CortexToolContext = ctx(),
): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    tool(name: string, description: string, shape: any, handler: any) {
      tools.set(name, { name, description, shape, handler });
    },
    registerTool() { /* unused by this registrar */ },
  };
  registerGatedMcpTools(server as any, target => registerSubagentTools(target, context), allowlist);
  return tools;
}

function ctx(overrides: Partial<CortexToolContext> = {}): CortexToolContext {
  return {
    channel: 'web:42', sessionId: 'sess-1', sessionName: 'cortex-aaaa', threadId: null,
    profile: 'main', project: 'proj', taskProject: null, backend: 'claude',
    scheduleTaskId: null, callbackSource: null, branchMachine: null,
    webhookBaseUrl: 'http://127.0.0.1:3001', webhookToken: 'tok',
    askManagerTimeoutMs: 1000, slackBotToken: null, toolAllowlist: null,
    subagentPiModels: [], subagentClaudeModels: [],
    ...overrides,
  } as CortexToolContext;
}

/** The webhook answers in the daemon's `{ success, data }` envelope. */
function reply(data: unknown) {
  return { body: { success: true, data }, status: 200 };
}

function payloads() {
  return requestLoopbackJson.mock.calls.map(([, , body]: any[]) => body);
}

beforeEach(() => { requestLoopbackJson.mockReset(); });

// --- registration ---

test('the core bundle declares exactly the two delegation tools, and they register', () => {
  assert.deepEqual([...SUBAGENT_TOOLS], ['agent', 'agent_stop']);
  for (const name of SUBAGENT_TOOLS) {
    assert.ok(MCP_TOOLS_BY_SERVER['cortex-core'].includes(name), `${name} is declared on cortex-core`);
  }
  assert.deepEqual([...registerTools().keys()], ['agent', 'agent_stop']);
});

test('the tool gate can withhold the pair, which is how a child stays a leaf', () => {
  const allowlist = new Set(MCP_TOOLS_BY_SERVER['cortex-core'].filter(n => !SUBAGENT_TOOLS.includes(n)));
  assert.deepEqual([...registerTools(allowlist).keys()], []);
});

test('withoutSubagentTools spells out the full remaining allowlist rather than trusting fail-open', () => {
  const result = withoutSubagentTools(undefined, ['cortex-core']);
  for (const name of SUBAGENT_TOOLS) assert.equal(result.includes(name), false);
  // Everything else the bundle declares survives, so hiding the pair costs nothing else.
  for (const name of MCP_TOOLS_BY_SERVER['cortex-core']) {
    if (!SUBAGENT_TOOLS.includes(name)) assert.ok(result.includes(name), `${name} survived`);
  }
});

test('the agent tool advertises all three modes and the background flag', () => {
  const { shape, description } = registerTools().get('agent')!;
  for (const key of ['description', 'prompt', 'subagent_type', 'model', 'backend', 'parallel', 'chain', 'run_in_background']) {
    assert.ok(key in shape, `${key} is an agent parameter`);
  }
  assert.equal(shape.backend.safeParse('pi').success, true);
  assert.equal(shape.backend.safeParse('gpt').success, false);
  assert.equal(shape.backend.safeParse(undefined).success, true);
  assert.match(description, /cannot spawn further subagents/);
});

// --- webhook proxy ---

test('a foreground call starts the run, then polls until it settles', async () => {
  requestLoopbackJson
    .mockResolvedValueOnce(reply({ id: 'sa_1', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_1', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_1', status: 'completed', text: 'the answer' }));

  const result = await registerTools().get('agent')!.handler({
    description: 'd', prompt: 'p', subagent_type: 'general-purpose',
  });

  assert.equal(result.content[0].text, 'the answer');
  assert.equal(result.isError, undefined);
  const [start, ...waits] = payloads();
  assert.equal(start.action, 'start');
  assert.equal(start.sessionId, 'sess-1');
  assert.equal(start.background, false);
  assert.deepEqual(start.params, { description: 'd', prompt: 'p', subagent_type: 'general-purpose' });
  // The parent's own scope travels with the call — that is what the child inherits routing from.
  assert.equal(start.profile, 'main');
  assert.equal(start.channel, 'web:42');
  assert.equal(start.backend, 'claude');
  assert.deepEqual(waits.map(w => w.action), ['wait', 'wait']);
  assert.deepEqual(waits.map(w => w.runId), ['sa_1', 'sa_1']);
});

test('the foreground deadline stays a full hop under the shortest client idle timeout', () => {
  // Whoever hits their deadline first decides how the call ends, and only this side can end it
  // with a handover. Losing the race is how a still-working child lost its only waiter.
  assert.ok(FOREGROUND_DEADLINE_MS + WAIT_REQUEST_TIMEOUT_MS < CLIENT_IDLE_FLOOR_MS);
});

test('each completed hop reports progress, which is what keeps a long call from reading as idle', async () => {
  requestLoopbackJson
    .mockResolvedValueOnce(reply({ id: 'sa_p', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_p', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_p', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_p', status: 'completed', text: 'done' }));
  const sent: any[] = [];

  await registerTools().get('agent')!.handler(
    { description: 'd', prompt: 'p', subagent_type: 'general-purpose' },
    { _meta: { progressToken: 7 }, sendNotification: async (n: any) => { sent.push(n); } },
  );

  // Two `wait` hops came back running; the settling third needs no ping.
  assert.equal(sent.length, 2);
  assert.equal(sent[0].method, 'notifications/progress');
  assert.deepEqual(sent.map(n => n.params.progressToken), [7, 7]);
  assert.deepEqual(sent.map(n => n.params.progress), [1, 2]);
  assert.match(sent[0].params.message, /sa_p/);
});

test('a caller that asked for no progress, or a notification seam that fails, is not an error', async () => {
  requestLoopbackJson
    .mockResolvedValueOnce(reply({ id: 'sa_q', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_q', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_q', status: 'completed', text: 'done' }))
    .mockResolvedValueOnce(reply({ id: 'sa_r', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_r', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_r', status: 'completed', text: 'done' }));
  const tools = registerTools();

  const noToken = await tools.get('agent')!.handler(
    { description: 'd', prompt: 'p', subagent_type: 'general-purpose' },
    { sendNotification: async () => { throw new Error('never asked for'); } },
  );
  const throwing = await tools.get('agent')!.handler(
    { description: 'd', prompt: 'p', subagent_type: 'general-purpose' },
    { _meta: { progressToken: 'tok' }, sendNotification: () => { throw new Error('transport gone'); } },
  );

  assert.equal(noToken.content[0].text, 'done');
  assert.equal(throwing.content[0].text, 'done');
});

test('a run that outlives the foreground deadline is handed to the background, and said so', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    requestLoopbackJson.mockImplementation(async (_m: string, _u: string, body: any) => {
      if (body.action === 'wait') {
        // Each hop lands a little further out; the second one is past the deadline.
        vi.setSystemTime(new Date(Date.now() + FOREGROUND_DEADLINE_MS));
        return reply({ id: 'sa_slow', status: 'running' });
      }
      return reply({ id: 'sa_slow', status: 'running' });
    });

    const result = await registerTools().get('agent')!.handler({
      description: 'd', prompt: 'p', subagent_type: 'general-purpose',
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /runs in the background/);
    assert.match(result.content[0].text, /delivered to you/);
    assert.match(result.content[0].text, /agent_stop\("sa_slow"\)/);
    // The handover is a request, not a hope: the daemon is told before the model is.
    assert.deepEqual(payloads().map(p => p.action), ['start', 'wait', 'detach']);
    assert.equal(payloads().at(-1)!.runId, 'sa_slow');
  } finally {
    vi.useRealTimers();
  }
});

test('a background call returns the id at once and never waits', async () => {
  requestLoopbackJson.mockResolvedValueOnce(reply({ id: 'sa_bg', status: 'running' }));
  const result = await registerTools().get('agent')!.handler({
    description: 'd', prompt: 'p', subagent_type: 'general-purpose', run_in_background: true,
  });
  assert.match(result.content[0].text, /Agent sa_bg started in the background/);
  assert.match(result.content[0].text, /agent_stop\("sa_bg"\)/);
  assert.equal(payloads().length, 1);
  assert.equal(payloads()[0].background, true);
  // The flag is the tool's own, not the daemon's — it must not reach the invocation schema.
  assert.equal('run_in_background' in payloads()[0].params, false);
});

test('a failed or stopped run comes back as a tool error, naming the run', async () => {
  requestLoopbackJson
    .mockResolvedValueOnce(reply({ id: 'sa_2', status: 'running' }))
    .mockResolvedValueOnce(reply({ id: 'sa_2', status: 'failed', error: 'model exploded' }));
  const failed = await registerTools().get('agent')!.handler({
    description: 'd', prompt: 'p', subagent_type: 'general-purpose',
  });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /Agent sa_2 failed: model exploded/);
});

test('a webhook error is reported rather than thrown', async () => {
  requestLoopbackJson.mockResolvedValueOnce({ body: { success: false, error: 'no such role' } });
  const result = await registerTools().get('agent')!.handler({ description: 'd' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /agent error: no such role/);
});

test('agent_stop proxies the id and reports the resulting status', async () => {
  requestLoopbackJson.mockResolvedValueOnce(reply({ id: 'sa_3', status: 'stopped' }));
  const result = await registerTools().get('agent_stop')!.handler({ agent_id: 'sa_3' });
  assert.equal(result.content[0].text, 'Agent sa_3 is now stopped.');
  assert.deepEqual(payloads()[0], { action: 'stop', sessionId: 'sess-1', runId: 'sa_3' });
});

// --- the Claude side of the substitution ---

function toolsOf(args: string[]): string[] {
  return args[args.indexOf('--tools') + 1].split(',');
}

const spawnBase = {
  tools: null, needsResume: false, sessionId: 'uuid-1',
};

/** A spawn that declares an allowlist re-materializes the MCP config, so the source must exist. */
function seedMcpConfig(): void {
  fs.mkdirSync(path.dirname(MCP_CONFIG), { recursive: true });
  fs.writeFileSync(MCP_CONFIG, JSON.stringify({
    mcpServers: { 'cortex-core': { command: 'node', args: ['bundled-server.js', JSON.stringify(['cortex-core'])], env: {} } },
  }));
}

test('Claude spawns never list the native Agent tool and always list the MCP pair', () => {
  const tools = toolsOf(buildSpawnArgs(spawnBase));
  assert.equal(tools.includes('Agent'), false, 'no native Agent');
  for (const name of subagentBridgeTools()) assert.ok(tools.includes(name), `lists ${name}`);
  // The constants themselves are already clean, so nothing depends on the strip alone.
  assert.equal(DEFAULT_TOOLS.split(',').includes('Agent'), false);
});

test('a caller that asks for Agent by name still does not get it', () => {
  const tools = toolsOf(buildSpawnArgs({ ...spawnBase, tools: 'Agent,Read' }));
  assert.deepEqual(tools.filter(t => !t.startsWith('mcp__')), ['Read']);
});

test('a subagent child lists no delegation tools — the allowlist is what gates it', () => {
  seedMcpConfig();
  const tools = toolsOf(buildSpawnArgs({
    ...spawnBase,
    mcpComposition: 'direct',
    mcpToolAllowlist: withoutSubagentTools(undefined, ['cortex-core']),
  }));
  for (const name of subagentBridgeTools()) assert.equal(tools.includes(name), false, `${name} withheld`);
  assert.equal(tools.includes('Agent'), false);
});

test('a spawn with no MCP at all lists neither the native tool nor its replacement', () => {
  const tools = toolsOf(buildSpawnArgs({ ...spawnBase, mcpComposition: 'none' }));
  assert.equal(tools.some(t => t.startsWith('mcp__cortex-core__agent')), false);
  assert.equal(tools.includes('Agent'), false);
});
