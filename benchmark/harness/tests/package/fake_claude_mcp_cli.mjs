// input:  Claude stream-json, MCP server and frozen run config
// output: deterministic direct and coder-review turns
// pos:    Installed-form Claude fixture for the six-row package matrix
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const RUN_CONFIG_PATH = '/logs/agent/arm-resolution.json';
const OBSERVATION_PATH = '/app/s1-backend-observation.json';
const WORKSPACE_STATE = 'matrix-workspace-state.json';
const THREAD_CALL_ID = 's3-thread-run';
const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)\n');
  process.exit(0);
}

function argumentValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function mcpConfigPaths() {
  const start = argv.indexOf('--mcp-config');
  if (start < 0) return [];
  const values = [];
  for (const value of argv.slice(start + 1)) {
    if (value.startsWith('--')) break;
    values.push(value);
  }
  return values;
}

function readRunConfig() {
  const bytes = fs.readFileSync(RUN_CONFIG_PATH);
  return {
    bytes,
    document: JSON.parse(bytes.toString('utf8')),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function send(server, value) {
  server.stdin.write(`${JSON.stringify(value)}\n`);
}

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function responseWithId(iterator, id) {
  while (true) {
    const next = await withTimeout(iterator.next(), `MCP response ${id}`);
    if (next.done) throw new Error(`MCP server closed before response ${id}`);
    const message = JSON.parse(next.value);
    if (message.id === id) return message;
  }
}

function processExit(server) {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('exit', resolve);
    server.once('error', reject);
  });
}

async function closeServer(server) {
  server.stdin.end();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('MCP server close timeout')), 5_000);
  });
  try {
    await Promise.race([processExit(server), timeout]);
  } catch {
    server.kill('SIGKILL');
    await processExit(server);
  } finally {
    clearTimeout(timer);
  }
}

function openDeclaredServer(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entries = Object.entries(config.mcpServers ?? {});
  if (entries.length !== 1 || entries[0][0] !== 'cortex-benchmark-thread') {
    throw new Error('strict MCP config omitted cortex-benchmark-thread');
  }
  const entry = entries[0][1];
  const server = spawn(entry.command, entry.args ?? [], {
    cwd: entry.cwd,
    env: { ...process.env, ...(entry.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: server.stdout, crlfDelay: Infinity });
  return { entry, server, lines, iterator: lines[Symbol.asyncIterator]() };
}

async function initializeServer(connection) {
  send(connection.server, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'cortex-s3-fake-claude', version: '1.0.0' },
    },
  });
  const response = await responseWithId(connection.iterator, 1);
  if (response.error) throw new Error(JSON.stringify(response.error));
  send(connection.server, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function listServerTools(connection) {
  send(connection.server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const response = await responseWithId(connection.iterator, 2);
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.result?.tools ?? [];
}

async function callThreadRun(connection) {
  send(connection.server, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'thread_run', arguments: { handoff: 'execute the fixed matrix fixture' } },
  });
  const response = await responseWithId(connection.iterator, 3);
  if (response.error || response.result?.isError) throw new Error(JSON.stringify(response));
  return response.result;
}

async function inspectAndRunStrictServer(configPath) {
  const connection = openDeclaredServer(configPath);
  try {
    await initializeServer(connection);
    const tools = await listServerTools(connection);
    const result = await callThreadRun(connection);
    const policyPath = connection.entry.env?.CORTEX_BENCHMARK_THREAD_POLICY_PATH ?? null;
    const policy = policyPath ? JSON.parse(fs.readFileSync(policyPath, 'utf8')) : null;
    return {
      policyPath, policyTemplate: policy?.template ?? null,
      tools: tools.map(tool => tool.name), result,
    };
  } finally {
    connection.lines.close();
    await closeServer(connection.server);
  }
}

function childReply(orchestration) {
  const statePath = path.join(process.cwd(), WORKSPACE_STATE);
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify({ attempt: 1, final: 'coded' }));
    return 'implemented the fixed matrix fixture';
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (orchestration.coder_review_variant === 'reviewer-fix') {
    fs.writeFileSync(statePath, JSON.stringify({ attempt: 1, final: 'fixed' }));
    return 'fixed and verified the matrix fixture. [FIX-VERIFIED]';
  }
  if (process.cwd() === '/app') {
    fs.writeFileSync(statePath, JSON.stringify({ attempt: 2, final: 'retried' }));
    return 'retried the fixed matrix fixture';
  }
  return state.attempt === 1
    ? 'audit found one blocker' : 'the final audit is correct. [IMPL-APPROVED]';
}

function emitThreadResult(threadResult) {
  if (!threadResult) return;
  process.stdout.write(`${JSON.stringify({
    type: 'assistant', message: {
      id: 's3-claude-tool', role: 'assistant', model: 's3-fake-claude',
      content: [{
        type: 'tool_use', id: THREAD_CALL_ID,
        name: 'mcp__cortex-benchmark-thread__thread_run', input: {},
      }],
    },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'user', message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: THREAD_CALL_ID,
      content: JSON.stringify(threadResult), is_error: false,
    }] },
  })}\n`);
}

function emitAssistantText(text) {
  process.stdout.write(`${JSON.stringify({
    type: 'assistant', message: {
      id: 's3-claude-message', role: 'assistant', model: 's3-fake-claude',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 3, output_tokens: 2,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
    },
  })}\n`);
}

function emitTerminalResult(request, text) {
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    session_id: request.session_id, result: text,
    total_cost_usd: 0, num_turns: 1,
    usage: {
      input_tokens: 3, output_tokens: 2,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    },
  })}\n`);
}

function emitReply(request, text, threadResult = null) {
  emitThreadResult(threadResult);
  emitAssistantText(text);
  emitTerminalResult(request, text);
}

function readRequestLine() {
  return withTimeout(new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let received = false;
    lines.once('line', (line) => {
      received = true;
      resolve(line);
      lines.close();
    });
    lines.once('close', () => {
      if (!received) reject(new Error('Claude fixture received no request'));
    });
  }), 'Claude request');
}

function writeObservation(config, orchestration, paths, strict) {
  fs.writeFileSync(OBSERVATION_PATH, JSON.stringify({
    backend: 'claude', mode: orchestration.mode,
    variant: orchestration.coder_review_variant ?? null,
    armName: config.document.arm.name,
    runConfigPath: RUN_CONFIG_PATH, runConfigSha256: config.sha256,
    cwd: process.cwd(), argv,
    tools: (argumentValue('--tools') ?? '').split(',').filter(Boolean),
    strictMcpConfig: argv.includes('--strict-mcp-config'),
    mcpConfigPaths: paths, policyPath: strict.policyPath,
    policyTemplate: strict.policyTemplate,
    policyWritableBits: strict.policyPath && fs.existsSync(strict.policyPath)
      ? fs.statSync(strict.policyPath).mode & 0o222 : null,
    registered: strict.tools,
  }));
}

async function main() {
  const config = readRunConfig();
  const orchestration = config.document.arm.orchestration;
  const paths = mcpConfigPaths();
  const requestLine = await readRequestLine();
  const parent = orchestration.mode === 'direct' || paths.length > 0;
  const strict = paths.length > 0
    ? await inspectAndRunStrictServer(paths[0])
    : { policyPath: null, policyTemplate: null, tools: [], result: null };
  if (parent) writeObservation(config, orchestration, paths, strict);
  const text = parent ? 'deterministic installed reply' : childReply(orchestration);
  emitReply(JSON.parse(requestLine), text, strict.result);
  setTimeout(() => process.exit(0), 10);
}

try {
  await main();
} catch (error) {
  fs.writeFileSync(OBSERVATION_PATH, JSON.stringify({
    backend: 'claude', argv, cwd: process.cwd(),
    fixtureError: error?.stack ?? String(error),
  }));
  console.error(error?.stack ?? String(error));
  setTimeout(() => process.exit(1), 10);
}
