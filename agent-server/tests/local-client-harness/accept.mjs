// Deliberately NOT run by preflight.py. Requires a parent-supplied final product tgz.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { CORTEX, EVIDENCE, SERVER, inventory, identity, key, births, monitor, assertBirthSummary } from './processes.mjs';
import { initialize, cli, until, delay, webhook, tools } from './product.mjs';

let phase = 'initialize';
const report = { ok: false, productRun: true, phases: [] };
const daemonLeaders = new Set();
let rejectedContenders = 0;

function running() {
  const entries = inventory();
  const one = role => {
    const found = entries.filter(p => p.role === role);
    assert.equal(found.length, 1);
    return found[0];
  };
  const result = { daemon: one('daemon'), app: one('app'), client: one('client') };
  assert.equal(Number(fs.readFileSync(`${CORTEX}/data/daemon.pid`, 'utf8')), result.daemon.pid);
  assert.equal(Number(fs.readFileSync(`${CORTEX}/data/daemon-child.pid`, 'utf8')), result.app.pid);
  return result;
}

function hellos() {
  const file = `${EVIDENCE}/hello.jsonl`;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function ready(context) {
  return until(async () => {
    const processes = running();
    const online = await webhook(context.tokens, 'devices');
    assert.deepEqual(online.devices, ['test-local']);
    const hello = hellos().find(h => h.appPid === processes.app.pid && h.hash === context.hash);
    assert(hello);
    return processes;
  });
}

async function unauthorizedWs() {
  const { WebSocket } = createRequire(`${SERVER}/package.json`)('ws');
  const status = await new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:3002', { handshakeTimeout: 3000 });
    socket.on('error', () => {});
    socket.once('open', () => { socket.close(); reject(new Error('Unauthenticated WS accepted')); });
    socket.once('unexpected-response', (_req, response) => {
      response.resume(); socket.terminate(); resolve(response.statusCode);
    });
    setTimeout(() => { socket.terminate(); reject(new Error('Auth check timed out')); }, 3500).unref();
  });
  assert.equal(status, 401);
}

async function authGates(context) {
  const request = token => fetch('http://127.0.0.1:3001/webhook/devices', {
    headers: token ? { 'x-cortex-token': token } : {}, signal: AbortSignal.timeout(3000),
  });
  assert.equal((await request()).status, 401);
  assert.equal((await request(context.tokens.client)).status, 401);
  await unauthorizedWs();
}

function birthCounts(clients, servers) {
  const records = { client: births('client'), app: births('app'), daemon: births('daemon') };
  assertBirthSummary(records, { client: clients, app: servers, daemon: servers + rejectedContenders }, daemonLeaders);
}

async function recordPhase(context, processes) {
  daemonLeaders.add(key(processes.daemon));
  const results = await tools(context.tokens);
  report.phases.push({ phase, processes, helloHash: context.hash, tools: results });
}

async function initial(context) {
  assert.equal(inventory().length, 0); // Init must prepare, never prestart a client.
  assert.equal(births('client').length, 0);
  phase = 'initial';
  await cli(['daemon']);
  const processes = await ready(context);
  await authGates(context);
  await recordPhase(context, processes);
  birthCounts(1, 1);
  return processes;
}

async function warm(context, previous) {
  phase = 'warm';
  for (let repeat = 0; repeat < 3; repeat++) {
    await cli(['daemon']);
    rejectedContenders++; // CLI forks a contender; the daemon's singleton lock must reject it.
  }
  await delay(2000);
  const current = await ready(context);
  assert.deepEqual(current, previous);
  birthCounts(1, 1); // Extra app/client starts still fail, including short-lived ones.
  await recordPhase(context, current);
  return current;
}

async function serverGone(previous) {
  await until(() => {
    assert(!inventory().some(p => p.role === 'daemon' || p.role === 'app'));
    assert.notEqual(identity(previous.daemon.pid)?.start, previous.daemon.start);
    assert.notEqual(identity(previous.app.pid)?.start, previous.app.start);
    return true;
  });
}

// `cortex daemon stop` takes down the daemon, its app and the client it launched.
async function stopDaemon(previous) {
  await cli(['daemon', 'stop']);
  await serverGone(previous);
  assert(!inventory().some(p => p.role === 'client'));
  assert.notEqual(identity(previous.client.pid)?.start, previous.client.start);
}

async function survivingCold(context, previous) {
  phase = 'cold-surviving-client';
  // A daemon that dies without `cortex daemon stop` (here: a signal) leaves its client running.
  // This is a PID from private /proc, revalidated by start time and exact daemon cmdline.
  assert.deepEqual(identity(previous.daemon.pid), previous.daemon);
  process.kill(previous.daemon.pid, 'SIGTERM');
  await serverGone(previous);
  assert.equal(key(identity(previous.client.pid)), key(previous.client));
  await cli(['daemon']);
  const current = await ready(context);
  assert.equal(key(current.client), key(previous.client));
  assert.notEqual(key(current.app), key(previous.app));
  assert.notEqual(key(current.daemon), key(previous.daemon));
  await recordPhase(context, current);
  birthCounts(1, 2);
  return current;
}

async function fullCold(context, previous) {
  phase = 'cold-full';
  await stopDaemon(previous);
  await cli(['daemon']);
  const current = await ready(context);
  assert.notEqual(key(current.client), key(previous.client));
  await recordPhase(context, current);
  birthCounts(2, 3);
  return current;
}

async function main() {
  const watching = monitor();
  try {
    const context = await initialize();
    const first = await initial(context);
    const repeated = await warm(context, first);
    const surviving = await survivingCold(context, repeated);
    const cold = await fullCold(context, surviving);
    await stopDaemon(cold);
    report.hash = context.hash;
    report.processes = watching.stop();
    assert.equal(report.processes.maximumClients, 1);
    report.clientBirths = births('client');
    report.rejectedDaemonContenders = rejectedContenders;
    report.ok = true;
  } catch {
    report.failedPhase = phase; // Never serialize assertions, tokens, headers, or raw CLI output.
    report.processes = watching.stop();
    process.exitCode = 1;
  }
  fs.writeFileSync(`${EVIDENCE}/acceptance.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
}

await main();
