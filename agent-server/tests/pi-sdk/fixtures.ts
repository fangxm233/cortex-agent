// input:  node HTTP/fs, MCP SDK, Pi session request types
// output: local provider, MCP server, private config and hook
// pos:    Credential-free transport fixtures for the SDK smoke
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OpenBundledMcpServer } from '../../src/agent-adapter/pi/mcp-bridge.js';
import type { PiSessionRequest } from '../../src/agent-adapter/pi/session-options.js';

export const SYSTEM = 'SDK smoke system sentinel: preserve me across every turn.';
export const APPEND = 'SDK smoke append sentinel: tools remain available.';
export const HOOK = 'SDK smoke hook sentinel: startup context is present.';
export const PROVIDER = 'cortex-smoke-local';
export const MODEL = 'smoke-model';
export const DUMMY_KEY = 'local-fixture-not-a-credential';
export const TODO_RESULT = 'Todos updated: 1 total, 1 completed, 0 in progress.';

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

export interface ChatRequest {
  model: string;
  stream: boolean;
  messages: ChatMessage[];
  tools: Array<{ type: string; function: { name: string; parameters: unknown } }>;
}

export interface CapturedRequest {
  url: string | undefined;
  authorization: string | undefined;
  body: ChatRequest;
}

function toolCalls(turn: number) {
  return [
    { index: 0, id: `todo_${turn}`, type: 'function', function: {
      name: 'todo_write', arguments: JSON.stringify({ todos: [{
        content: `smoke ${turn}`, status: 'completed', activeForm: 'Testing SDK',
      }] }),
    } },
    { index: 1, id: `echo_${turn}`, type: 'function', function: {
      name: 'smoke_echo', arguments: JSON.stringify({ value: `echo-${turn}` }),
    } },
  ];
}

function sendCompletion(response: ServerResponse, index: number): void {
  const turn = Math.ceil(index / 2);
  const usesTools = index % 2 === 1;
  const delta = usesTools
    ? { role: 'assistant', tool_calls: toolCalls(turn) }
    : { role: 'assistant', content: `finished-${turn}` };
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'x-codex-plan-type': 'smoke',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-used-percent': '25',
    'x-codex-primary-reset-at': '2000000000',
  });
  const chunk = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  const base = { id: `smoke-${index}`, object: 'chat.completion.chunk', created: 1, model: MODEL };
  chunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: usesTools ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  response.end('data: [DONE]\n\n');
}

async function handleRequest(
  request: IncomingMessage, response: ServerResponse, requests: CapturedRequest[],
): Promise<void> {
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, `Bearer ${DUMMY_KEY}`);
  assert.ok(requests.length < 6, 'unexpected retry or tool loop');
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
  sendCompletion(response, requests.length);
}

export async function startProvider() {
  const requests: CapturedRequest[] = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, requests).catch(error => {
      errors.push(error);
      response.writeHead(400).end('Invalid smoke request');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, errors,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

// The SDK and its provider client still serialize/stream normally. Only deny egress.
export function restrictFetch(baseUrl: string) {
  const original = globalThis.fetch;
  const blocked: string[] = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(baseUrl).origin) {
      blocked.push(url.origin);
      throw new Error(`SDK smoke denied external fetch: ${url.origin}`);
    }
    return original(input, { ...init, redirect: 'error' });
  };
  return { blocked, restore: () => { globalThis.fetch = original; } };
}

export function mcpFixture() {
  const calls: unknown[] = [];
  let opened = 0;
  let closed = 0;
  const open: OpenBundledMcpServer = async () => {
    opened++;
    const server = new Server({ name: 'smoke-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: 'smoke_echo', description: 'Echo a smoke sentinel',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      assert.equal(params.name, 'smoke_echo');
      calls.push(params.arguments);
      return { content: [{ type: 'text', text: `MCP:${params.arguments?.value}` }] };
    });
    return {
      connect: transport => server.connect(transport),
      close: async () => { closed++; await server.close(); },
    };
  };
  return { open, calls, counts: () => ({ opened, closed }) };
}

async function writeConfig(agentDir: string, baseUrl: string): Promise<void> {
  const provider = {
    baseUrl, api: 'openai-completions', apiKey: DUMMY_KEY,
    models: [{ id: MODEL, reasoning: false, contextWindow: 128000, maxTokens: 1024 }],
  };
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { [PROVIDER]: provider } }));
  await writeFile(join(agentDir, 'auth.json'), '{}');
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false },
    packages: [], extensions: [], skills: [], prompts: [],
  }));
}

async function writeStartupHook(home: string): Promise<void> {
  const dir = join(home, 'cortex', 'config', 'hooks');
  await mkdir(dir, { recursive: true });
  const output = JSON.stringify({ hookSpecificOutput: { additionalContext: HOOK } });
  await writeFile(join(dir, 'smoke-start.json'), JSON.stringify({
    id: 'smoke-start', event: 'agent:session-start', enabled: true,
    run: { command: `printf '%s' '${output}'` },
  }));
}

export async function sessionRequest(home: string, baseUrl: string): Promise<PiSessionRequest> {
  const cwd = join(home, 'workspace');
  const agentDir = join(home, 'agent');
  const sessionDir = join(home, 'sessions');
  for (const dir of [cwd, agentDir, sessionDir]) await mkdir(dir, { recursive: true });
  await writeConfig(agentDir, baseUrl);
  await writeStartupHook(home);
  return {
    sessionKey: 'sdk-smoke', cwd, agentDir, sessionDir, sessionPath: null,
    provider: PROVIDER, model: MODEL, thinking: 'off', systemPrompt: SYSTEM,
    appendSystemPrompt: [APPEND], skillPaths: [], disableHooks: false,
    reportsProviderQuota: true, pluginMcpServers: [], streamDeltas: true,
    env: { PI_CODING_AGENT_DIR: agentDir, CORTEX_PI_ALLOWED_TOOLS: 'TodoWrite',
      CORTEX_PI_MCP_COMPOSITION: 'direct' },
  };
}
