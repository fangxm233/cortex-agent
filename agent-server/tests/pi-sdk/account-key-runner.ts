// Run in an isolated home by account-key.test.ts: one real PI SDK session over Cortex's own agent
// dir and one over a PI account's, each with the catalog the daemon's adapter writes there, against
// a local provider that records the key each request carries.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { writeConnections } from '../../src/core/connections-file.js';
import { PI_AGENT_DIR } from '../../src/agent-adapter/pi/defaults.js';
import { createPiRuntime } from '../../src/agent-adapter/pi/runtime.js';
import type { PiSessionRequest } from '../../src/agent-adapter/pi/session-options.js';
import { resolvePiAccountRoute } from '../../src/domain/connections/pi-account-dir.js';
import { getPiEngineAdapter } from '../../src/domain/runs/adapters.js';
import { MODEL, PROVIDER, mcpFixture, restrictFetch } from './fixtures.js';

const ROUTE_KEY = 'connection-route-key';
const ACCOUNT_KEY = 'account-own-key';

function reply(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'acct', object: 'chat.completion.chunk', created: 1, model: MODEL };
  const chunk = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] });
  chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  response.end('data: [DONE]\n\n');
}

async function startProvider() {
  const keys: Array<string | undefined> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    keys.push(request.headers.authorization);
    request.resume().on('end', () => reply(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, keys,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function sessionRequest(agentDir: string, key: string): PiSessionRequest {
  const home = process.env.HOME!;
  const cwd = join(home, 'workspace');
  const sessionDir = join(home, 'sessions');
  for (const dir of [cwd, sessionDir]) mkdirSync(dir, { recursive: true });
  return {
    sessionKey: `account-key-${key}`, cwd, agentDir, sessionDir, sessionPath: null,
    provider: PROVIDER, model: MODEL, thinking: 'off', systemPrompt: 'account key check',
    appendSystemPrompt: [], skillPaths: [], disableHooks: true, reportsProviderQuota: false,
    pluginMcpServers: [], streamDeltas: false,
    env: { PI_CODING_AGENT_DIR: agentDir, CORTEX_PI_ALLOWED_TOOLS: 'TodoWrite', CORTEX_PI_MCP_COMPOSITION: 'direct' },
  };
}

async function keySent(agentDir: string, label: string, keys: Array<string | undefined>): Promise<string | undefined> {
  const before = keys.length;
  const runtime = await createPiRuntime(sessionRequest(agentDir, label), { onEvent: () => {} },
    { openBundledMcpServer: mcpFixture().open });
  try {
    await runtime.session.prompt('say ok');
  } finally {
    await runtime.dispose();
  }
  assert.equal(keys.length, before + 1, `${label}: one request`);
  return keys.at(-1);
}

function setUp(baseUrl: string): string {
  writeConnections([
    { id: PROVIDER, backend: 'pi', provider: PROVIDER, api: 'openai-completions', baseUrl, key: ROUTE_KEY,
      models: [{ id: MODEL, reasoning: false, contextWindow: 128000, maxTokens: 1024 }] },
    { id: 'smoke-acct', backend: 'pi', type: 'account', provider: PROVIDER, label: 'Smoke account' },
  ]);
  const route = resolvePiAccountRoute({ backend: 'pi', provider: PROVIDER, connection: 'smoke-acct' });
  assert.ok(route);
  writeFileSync(join(route.agentDir, 'auth.json'), JSON.stringify({ [PROVIDER]: { type: 'api_key', key: ACCOUNT_KEY } }));
  const adapter = getPiEngineAdapter();
  adapter.ensureCatalog(route.agentDir);
  adapter.ensureCatalog();
  const written = JSON.parse(readFileSync(join(route.agentDir, 'models.json'), 'utf8'));
  assert.equal(written.providers[PROVIDER].baseUrl, baseUrl);
  assert.equal('apiKey' in written.providers[PROVIDER], false, 'no connection key in the account catalog');
  return route.agentDir;
}

async function main(): Promise<void> {
  const provider = await startProvider();
  const network = restrictFetch(provider.baseUrl);
  try {
    const accountDir = setUp(provider.baseUrl);
    assert.equal(await keySent(PI_AGENT_DIR, 'default', provider.keys), `Bearer ${ROUTE_KEY}`);
    assert.equal(await keySent(accountDir, 'account', provider.keys), `Bearer ${ACCOUNT_KEY}`);
    assert.deepEqual(network.blocked, []);
    console.log('PI_ACCOUNT_KEY_OK default=connection account=own');
  } finally {
    network.restore();
    await provider.close();
  }
}

await main();
