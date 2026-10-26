// Opt-in paid test. Credentials must already be installed in isolated HOME/CORTEX_HOME.
// No login or credential copying here; never use rotating OAuth credentials for this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.join(path.resolve(process.argv[2]), 'lib/node_modules/@cortex-agent/server');
const home = process.env.CORTEX_HOME;
assert(home?.startsWith('/tmp/') && process.env.HOME?.startsWith('/tmp/'));
const output = path.join(path.dirname(home), 'turns');
fs.mkdirSync(output, { recursive: true });
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, CORTEX_HOME: home,
  CORTEX_TELEMETRY: '0', CORTEX_UI_HTTP: '1', CORTEX_PORT_FORWARD: '0',
  WEBHOOK_PORT: '17301', CORTEX_CLIENT_PORT: '17302', CORTEX_TUI_PORT: '17303', CORTEX_UI_PORT: '17304',
  CORTEX_CLIENT_HOST: '127.0.0.1', CORTEX_CLIENT_TOKEN: 'bundle-smoke-client-token',
  CORTEX_WEBHOOK_TOKEN: 'bundle-smoke-webhook-token', CORTEX_BUNDLE_SMOKE_GATEWAY_PORT: '17380',
  NODE_OPTIONS: `--import=${fileURLToPath(new URL('./bundle-turn-preload.mjs', import.meta.url))}`,
};
const base = 'http://127.0.0.1:17304/trpc/';
const headers = { 'x-cortex-token': env.CORTEX_CLIENT_TOKEN, 'content-type': 'application/json' };
async function api(method, input = {}, post = false) {
  const url = base + method + (post ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`);
  const response = await fetch(url, { method: post ? 'POST' : 'GET', headers, ...(post ? { body: JSON.stringify(input) } : {}) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); return result.result.data;
}
async function waitReady(child) {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch('http://127.0.0.1:17304/api/ui/session')).ok) return; } catch {}
    assert(child.exitCode === null, 'Server exited'); await delay(100);
  }
  throw new Error('Server readiness timeout');
}
async function consume(response, events) {
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) return;
    pending += decoder.decode(value, { stream: true });
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (data?.slice(6).trim()) events.push(JSON.parse(data.slice(6)));
    }
  }
}
async function turn(selection) {
  const { sessionId } = await api('sessions.create', {}, true);
  await api('sessions.setSelection', { sessionId, selection }, true);
  const controller = new AbortController(); const events = [];
  const filter = { events: ['session.message', 'session.message.delta', 'session.status'], sessionId };
  const response = await fetch(base + 'subscribe?input=' + encodeURIComponent(JSON.stringify(filter)), { headers, signal: controller.signal });
  assert.equal(response.status, 200); assert(response.headers.get('content-type').includes('text/event-stream'));
  const stream = consume(response, events).catch(error => { events.push({ streamError: String(error) }); });
  try {
    await api('sessions.send', { sessionId, text: 'Smoke test only. Call bash (Bash) with command echo BUNDLE_TOOL_OK, then call the Cortex current_time tool with timezone UTC. Finally reply exactly BUNDLE_TURN_OK. Do not read or write files and do not call other tools.' }, true);
    await waitTurn(events);
    const transcript = await api('sessions.transcript', { sessionId });
    fs.writeFileSync(path.join(output, `${selection.backend}-transcript.json`), JSON.stringify(transcript, null, 2));
    return verifyTurn(selection, sessionId, events);
  } finally {
    controller.abort(); await stream;
    fs.writeFileSync(path.join(output, `${selection.backend}-events.json`), JSON.stringify(events, null, 2));
    await api('sessions.cancel', { sessionId }, true);
  }
}
function eventBodies(events) { return events.map(event => event?.payload ?? event?.data ?? event).filter(event => event && typeof event === 'object'); }
async function waitTurn(events) {
  for (let i = 0; i < 1800; i++) {
    const bodies = eventBodies(events);
    if (bodies.some(event => event.type === 'session.message') && bodies.at(-1)?.type === 'session.status' && bodies.at(-1)?.running === false) return;
    await delay(100);
  }
  throw new Error('Turn timeout (180 seconds)');
}
function verifyTurn(selection, sessionId, events) {
  const bodies = eventBodies(events);
  const deltas = bodies.filter(event => event.type === 'session.message.delta' && event.text && !event.snapshot);
  const tools = bodies.filter(event => event.type === 'session.message' && event.role === 'tool');
  const text = bodies.filter(event => event.role === 'assistant').map(event => event.text).join('\n');
  assert(deltas.length > 0, 'No streamed deltas'); assert(text.includes('BUNDLE_TURN_OK'), text);
  assert(tools.some(event => /bash/i.test(event.toolName)), JSON.stringify(tools));
  assert(tools.some(event => /current_time/.test(event.toolName)), JSON.stringify(tools));
  const toolResults = backendToolResults(sessionId, selection.backend);
  assert(toolResults.some(text => text.includes('BUNDLE_TOOL_OK')), 'Missing shell result');
  assert(toolResults.some(text => text.includes('unix_ms')), 'Missing Cortex time result');
  return { selection, sessionId, status: 'pass', streamedDeltas: deltas.length, tools: tools.map(event => event.toolName), toolResults, reply: text }; 
}
function jsonlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jsonlFiles(file) : entry.name.endsWith('.jsonl') ? [file] : [];
  });
}
function backendToolResults(sessionId, backend) {
  const history = fs.readFileSync(path.join(home, 'data/conversation-history', `${sessionId}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const ids = new Set(history.filter(row => row.type === 'tool').map(row => row.toolUseId));
  const dir = path.join(home, backend === 'pi' ? 'logs/sessions-pi' : 'data/claude/projects');
  const results = [];
  for (const file of jsonlFiles(dir)) {
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) results.push(...matchingToolResults(JSON.parse(line).message, ids));
  }
  return results;
}
function matchingToolResults(message, ids) {
  if (message?.role === 'toolResult' && ids.has(message.toolCallId) && !message.isError) return [JSON.stringify(message.content)];
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter(part => part.type === 'tool_result' && ids.has(part.tool_use_id) && !part.is_error).map(part => JSON.stringify(part.content));
}
if (process.argv.includes('--verify-recorded-pi')) {
  const events = JSON.parse(fs.readFileSync(path.join(output, 'pi-events.json'), 'utf8'));
  const sessionId = eventBodies(events).find(event => event.sessionId)?.sessionId;
  const result = verifyTurn({ backend: 'pi', provider: 'deepseek', model: 'deepseek-chat', thinking: null, mode: 'deepseek' }, sessionId, events);
  fs.writeFileSync(path.join(output, 'pi-verified.json'), JSON.stringify(result, null, 2));
  console.log('Recorded pi turn verified without another paid request'); process.exit(0);
}
for (const port of [17301, 17302, 17303, 17304, 17380]) {
  await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
}
const child = spawn(process.execPath, [path.join(root, 'dist/entry/daemon.js')], { env, cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const log = fs.createWriteStream(path.join(output, 'daemon.log'));
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
const results = [];
try {
  await waitReady(child); await delay(2500);
  for (const selection of [
    { backend: 'claude', provider: null, model: process.env.CORTEX_BUNDLE_CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001', thinking: null, mode: 'api' },
    { backend: 'pi', provider: 'deepseek', model: 'deepseek-chat', thinking: null, mode: 'deepseek' },
  ]) {
    if (!(process.env.CORTEX_BUNDLE_BACKENDS ?? 'claude,pi').split(',').includes(selection.backend)) continue;
    try { results.push(await turn(selection)); }
    catch (error) { results.push({ selection, status: 'fail', error: error.stack }); }
    console.log(selection.backend, results.at(-1).status);
  }
} finally {
  child.kill('SIGTERM');
  for (let i = 0; i < 150 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await delay(1000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  log.end();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
if (results.some(result => result.status !== 'pass')) process.exitCode = 1;
