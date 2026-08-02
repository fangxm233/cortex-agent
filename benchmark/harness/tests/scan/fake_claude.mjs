// input:  Claude print argv, stream-json prompt, benchmark MCP config
// output: offline parent/child streams and one real blocking thread call
// pos:    Deterministic model substitute for dynamic container proof
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '2.1.999 (Cortex benchmark fake)';
const TOOL_ID = 'benchmark-thread-call-1';
const args = process.argv.slice(2);
const artifactDir = process.env.FAKE_CLAUDE_ARTIFACT_DIR;

function requireArtifactDir() {
  if (!artifactDir) throw new Error('FAKE_CLAUDE_ARTIFACT_DIR is required');
  return artifactDir;
}

function argumentValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function invocationRole() {
  const tools = argumentValue('--tools') ?? '';
  if (tools.includes('cortex-benchmark-thread')) return 'parent';
  const prompt = argumentValue('--system-prompt') ?? '';
  if (prompt.includes('implementation auditor')) return 'benchmark-reviewer';
  if (prompt.includes('code implementer')) return 'benchmark-coder';
  throw new Error('Unable to classify fake Claude invocation');
}

function appendJson(file, value) {
  fs.appendFileSync(path.join(requireArtifactDir(), file), `${JSON.stringify(value)}\n`);
}

function writeInvocationEvidence(role, request) {
  appendJson('fake-claude-invocations.jsonl', { role, args, cwd: process.cwd() });
  fs.writeFileSync(path.join(requireArtifactDir(), `fake-claude-${role}-stdin.json`), request);
  if (role !== 'parent') return;
  fs.writeFileSync(path.join(requireArtifactDir(), 'fake-claude-argv.txt'), `${args.join('\n')}\n`);
  fs.writeFileSync(path.join(requireArtifactDir(), 'fake-claude-cwd.txt'), `${process.cwd()}\n`);
  fs.writeFileSync(path.join(requireArtifactDir(), 'fake-claude-stdin.json'), request);
}

async function firstInputLine() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    lines.close();
    return line;
  }
  throw new Error('Fake Claude received no stream-json request');
}

function usageFor(role) {
  if (role === 'benchmark-coder') {
    return { input_tokens: 13, output_tokens: 8, cache_creation_input_tokens: 2,
      cache_read_input_tokens: 4, cost_usd: 0.002 };
  }
  if (role === 'benchmark-reviewer') {
    return { input_tokens: 17, output_tokens: 9, cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6, cost_usd: 0.003 };
  }
  return { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 3,
    cache_read_input_tokens: 5, cost_usd: 0.001 };
}

function emit(role, value) {
  const line = JSON.stringify(value);
  process.stdout.write(`${line}\n`);
  appendJson(`fake-claude-${role}-output.jsonl`, value);
  if (role === 'parent') appendJson('fake-claude-output.jsonl', value);
}

function assistantMessage(role, content, usage) {
  return {
    type: 'assistant',
    message: {
      id: `fake-${role}-message`, role: 'assistant', model: 'claude-fake-benchmark',
      content, usage,
    },
  };
}

function resultMessage(role, sessionId, usage, text) {
  return {
    type: 'result', subtype: 'success', is_error: false, session_id: sessionId,
    result: text, total_cost_usd: usage.cost_usd, num_turns: 1,
    usage: {
      input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    },
    modelUsage: { 'claude-fake-benchmark': {} },
  };
}

async function waitForParentToolEvent() {
  const policy = JSON.parse(fs.readFileSync(process.env.CORTEX_BENCHMARK_THREAD_POLICY_PATH, 'utf8'));
  const journal = path.join(policy.trajectory_root, 'events.jsonl');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '';
    if (text.includes(TOOL_ID) && text.includes('tool_use')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Parent tool_use was not committed before thread_run');
}

function mcpServerEntry() {
  const configPath = argumentValue('--mcp-config');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entries = Object.entries(config.mcpServers ?? {});
  if (entries.length !== 1 || entries[0][0] !== 'cortex-benchmark-thread') {
    throw new Error('Parent MCP config did not contain only cortex-benchmark-thread');
  }
  return entries[0][1];
}

function sendMessage(server, value) {
  server.stdin.write(`${JSON.stringify(value)}\n`);
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function responseWithId(iterator, id) {
  while (true) {
    const next = await withTimeout(iterator.next(), 60_000, `MCP response ${id}`);
    if (next.done) throw new Error(`MCP server closed before response ${id}`);
    let message;
    try { message = JSON.parse(next.value); }
    catch {
      appendJson('fake-mcp-stdout-log.jsonl', { line: next.value });
      continue;
    }
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
  try { await withTimeout(processExit(server), 5_000, 'MCP server exit'); }
  catch {
    server.kill('SIGKILL');
    await processExit(server);
  }
}

function openMcpServer() {
  const entry = mcpServerEntry();
  const server = spawn(entry.command, entry.args ?? [], {
    cwd: entry.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const lines = createInterface({ input: server.stdout, crlfDelay: Infinity });
  return { server, lines, iterator: lines[Symbol.asyncIterator](), stderr: () => stderr };
}

async function initializeMcp(server, iterator) {
  sendMessage(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'cortex-benchmark-fake', version: '1.0.0' },
  } });
  const initialized = await responseWithId(iterator, 1);
  if (initialized.error) {
    throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)}`);
  }
  sendMessage(server, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function invokeThreadTool(server, iterator) {
  sendMessage(server, { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'thread_run', arguments: { handoff: 'Run the fixed two-role review.' } } });
  return responseWithId(iterator, 2);
}

async function callThreadRun() {
  const connection = openMcpServer();
  let called = null;
  try {
    await initializeMcp(connection.server, connection.iterator);
    called = await invokeThreadTool(connection.server, connection.iterator);
    if (called.error || called.result?.isError) {
      throw new Error(`thread_run failed: ${JSON.stringify(called.error ?? called.result)}`);
    }
    return called.result;
  } finally {
    connection.lines.close();
    await closeServer(connection.server);
    appendJson('fake-mcp-call.jsonl', { response: called, stderr: connection.stderr() });
  }
}

function approveReviewer(request) {
  const artifact = request.message.content.match(/(\/[^\s]+\/artifact\.md)/)?.[1];
  if (!artifact) throw new Error('Reviewer prompt contained no artifact path');
  fs.appendFileSync(artifact, '\nreview complete\n[IMPL-APPROVED]\n');
}

async function runChild(role, request) {
  const usage = usageFor(role);
  const text = role === 'benchmark-reviewer'
    ? 'review complete\n[IMPL-APPROVED]' : 'implementation complete';
  if (role === 'benchmark-reviewer') approveReviewer(request);
  emit(role, assistantMessage(role, [{ type: 'text', text }], usage));
  emit(role, resultMessage(role, request.session_id, usage, text));
}

async function runParent(request) {
  const usage = usageFor('parent');
  emit('parent', assistantMessage('parent', [{
    type: 'tool_use', id: TOOL_ID,
    name: 'mcp__cortex-benchmark-thread__thread_run',
    input: { handoff: 'Run the fixed two-role review.' },
  }], usage));
  await waitForParentToolEvent();
  const result = await callThreadRun();
  emit('parent', { type: 'user', session_id: request.session_id, message: {
    role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_ID,
      content: result.content, is_error: false }],
  } });
  emit('parent', assistantMessage('parent', [{ type: 'text', text: 'thread completed' }], {}));
  emit('parent', resultMessage('parent', request.session_id, usage, 'thread completed'));
}

async function main() {
  if (args[0] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    fs.writeFileSync(path.join(requireArtifactDir(), 'fake-claude-version.txt'), `${VERSION}\n`);
    return;
  }
  const requestLine = await firstInputLine();
  const request = JSON.parse(requestLine);
  const role = invocationRole();
  writeInvocationEvidence(role, requestLine);
  if (role === 'parent') await runParent(request);
  else await runChild(role, request);
}

await main();
