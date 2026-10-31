// Usage (Linux, from agent-server/ after `pnpm build`):
//   node scripts/bundle-main-port.mjs /tmp/cortex-bundle-main-port-<stamp>
// Two isolated homes, each with its own HOME and no main-port configuration, are installed one after
// the other as two users would (`cortex init` picks a free port while the first server runs), then
// both daemons are restarted at once from this checkout's dist/. Checks that each comes up on its own
// port and that hooks, signals, clients and the TUI reach only their own server; then that a main
// port held by another process stops app.js with exit 78 and no restart loop. Uses only the
// main-port search range; never the live ports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { claimRoot, createRunner, isolatedEnv, waitFor, command, readJson, saveJson } from './bundle-daemon-runtime.mjs';

const agentServer = path.resolve(import.meta.dirname, '..');
const dist = path.join(agentServer, 'dist/entry');
const { WebSocket } = createRequire(path.join(agentServer, 'package.json'))('ws');
const base = process.argv[2];
assert(base && /^\/tmp\/cortex-bundle-[^/]+$/.test(base), 'Pass a fresh /tmp/cortex-bundle-* path');
assert(fs.existsSync(path.join(dist, 'daemon.js')), 'Build first: pnpm build');
const results = [];

async function check(name, fn) {
  const detail = await fn();
  results.push({ name, ok: true, detail });
  console.log(`ok - ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

/** One isolated home with no main port and its own tokens. */
function makeHome(label, slot) {
  const root = `${base}-${label}`;
  claimRoot(root);
  const env = isolatedEnv(root, undefined, slot);
  for (const key of ['CORTEX_UI_PORT', 'CORTEX_CLIENT_TOKEN', 'CORTEX_WEBHOOK_TOKEN']) delete env[key];
  installStartHook(env.CORTEX_HOME, path.join(root, 'start-hook.json'));
  return { label, root, env, runner: createRunner(root, env) };
}

/** A `cortex:server.start` hook that records the port its server hands it and calls that port. */
function installStartHook(home, out) {
  fs.mkdirSync(path.join(home, 'config/hooks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config/hooks/main-port-probe.json'),
    JSON.stringify({ id: 'main-port-probe', event: 'cortex:server.start', run: { script: 'main-port-probe.mjs', timeout: 10 } }));
  fs.writeFileSync(path.join(home, 'hooks/main-port-probe.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    'const port = process.env.CORTEX_UI_PORT;',
    "const res = await fetch(`http://127.0.0.1:${port}/webhook/devices`, { headers: { 'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN ?? '' } }).catch(e => ({ status: String(e) }));",
    `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ port, status: res.status }));`,
  ].join('\n'));
}

const envFile = home => path.join(home.env.CORTEX_HOME, 'config/.env');
function dotenvValue(home, key) {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(envFile(home), 'utf8'));
  return match?.[1].trim();
}
const mainPort = home => Number(dotenvValue(home, 'CORTEX_UI_PORT'));

/** Signed-in GET of a webhook route; resolves to the HTTP status (0 when nothing answers). */
function webhookStatus(port, token) {
  return fetch(`http://127.0.0.1:${port}/webhook/devices`, { headers: { 'x-cortex-token': token } })
    .then(res => res.status, () => 0);
}

async function startDaemon(home, label = 'daemon') {
  return home.runner.start(process.execPath, [path.join(dist, 'daemon.js')], label);
}

async function waitServing(home) {
  const token = dotenvValue(home, 'CORTEX_WEBHOOK_TOKEN');
  await waitFor(async () => (await webhookStatus(mainPort(home), token)) === 200, `${home.label} serving`, 120000);
}

/** The status of a WebSocket upgrade: 'open', or the HTTP status that refused it. */
function upgradeStatus(url, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: token ? { 'x-cortex-token': token } : {} });
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout'); }, 5000);
    ws.once('open', () => { clearTimeout(timer); ws.close(); resolve('open'); });
    ws.once('unexpected-response', (_req, res) => { clearTimeout(timer); res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.once('error', () => { clearTimeout(timer); resolve('error'); });
  });
}

function runSignal(home, id, secret) {
  const env = { ...home.env, NODE_OPTIONS: home.env.NODE_OPTIONS };
  delete env.CORTEX_UI_PORT;
  const result = spawnSync(process.execPath, [path.join(dist, 'signal-cli.js'), '--id', id, '--secret', secret, '--status', 'ok'],
    { env, encoding: 'utf8', timeout: 30000 });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function createWaitpoint(home) {
  const res = await fetch(`http://127.0.0.1:${mainPort(home)}/webhook/waitpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cortex-token': dotenvValue(home, 'CORTEX_WEBHOOK_TOKEN') },
    body: JSON.stringify({ action: 'create', channel: 'main-port-check', label: 'main-port', intent: 'integration check' }),
  });
  const body = await res.json();
  assert.equal(body.success, true, JSON.stringify(body));
  return body.data;
}

const waitpointState = (home, id) => readJson(path.join(home.env.CORTEX_HOME, 'data/waitpoints.json'))[id]?.state;

function appStarts(home) {
  const file = home.env.CORTEX_BUNDLE_EVENTS;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.type === 'process-start' && event.argv.some(arg => arg.endsWith('entry/app.js')));
}

function holdPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Install and start each home in turn; the second install sees the first server's port bound. */
async function installBoth(a, b) {
  for (const home of [a, b]) {
    await command(home.runner, process.execPath, [path.join(dist, 'cli.js'), 'init'], 'init', 300000);
    home.daemon = await startDaemon(home);
    await waitServing(home);
  }
  await check('init picked distinct free main ports without configuration', () => {
    const ports = [mainPort(a), mainPort(b)];
    assert.notEqual(ports[0], ports[1]);
    assert(ports.every(port => port >= 26789 && port <= 26999), String(ports));
    assert.notEqual(dotenvValue(a, 'CORTEX_CLIENT_TOKEN'), dotenvValue(b, 'CORTEX_CLIENT_TOKEN'));
    return ports;
  });
}

async function checkIsolation(a, b) {
  await check('each webhook token works on its own port only', async () => {
    for (const [own, other] of [[a, b], [b, a]]) {
      const token = dotenvValue(own, 'CORTEX_WEBHOOK_TOKEN');
      assert.equal(await webhookStatus(mainPort(own), token), 200);
      assert.equal(await webhookStatus(mainPort(other), token), 401);
    }
  });
  await check('each server hands its hooks its own port', async () => {
    const seen = [];
    for (const home of [a, b]) {
      const probe = await waitFor(() => fs.existsSync(path.join(home.root, 'start-hook.json')) && readJson(path.join(home.root, 'start-hook.json')), `${home.label} hook`, 30000);
      assert.deepEqual(probe, { port: String(mainPort(home)), status: 200 });
      seen.push(probe);
    }
    return seen;
  });
  await checkSockets(a, b);
  await checkSignals(a, b);
}

async function checkSockets(a, b) {
  await check('clients and the TUI reach only their own server', async () => {
    for (const [own, other] of [[a, b], [b, a]]) {
      const token = dotenvValue(own, 'CORTEX_CLIENT_TOKEN');
      for (const route of ['/client', '/', '/tui']) {
        assert.equal(await upgradeStatus(`ws://127.0.0.1:${mainPort(own)}${route}`, token), 'open', `${own.label}${route}`);
        assert.equal(await upgradeStatus(`ws://127.0.0.1:${mainPort(other)}${route}`, token), 401, `${own.label} token on ${other.label}${route}`);
      }
      assert.equal(await upgradeStatus(`ws://127.0.0.1:${mainPort(own)}/tui`, null), 401);
    }
  });
}

async function checkSignals(a, b) {
  const { id, secret } = await createWaitpoint(a);
  await check('a signal sent from the other home is spooled there, not delivered', () => {
    const result = runSignal(b, id, secret);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.match(result.stdout, /^spooled .* \(HTTP 404: /);
    assert(result.stdout.includes(path.join(b.env.CORTEX_HOME, 'tmp/signals')), result.stdout);
    assert.equal(waitpointState(a, id), 'armed');
    return result.stdout;
  });
  await check('the same signal from its own home is accepted', async () => {
    const result = runSignal(a, id, secret);
    assert.equal(result.code, 0, JSON.stringify(result));
    await waitFor(() => waitpointState(a, id) !== 'armed', 'waitpoint resolved', 15000);
    return { stdout: result.stdout, state: waitpointState(a, id) };
  });
}

async function checkPortTaken(a, daemon) {
  await a.runner.stop(daemon);
  const port = mainPort(a);
  const holder = await holdPort(port);
  const before = appStarts(a).length;
  try {
    const restarted = await startDaemon(a, 'daemon-port-taken');
    const record = path.join(a.env.CORTEX_HOME, 'data/app-stopped.json');
    await waitFor(() => fs.existsSync(record), 'app-stopped record', 60000);
    await delay(8000);
    await check('a taken main port stops app.js with exit 78 and no restart loop', () => {
      const stop = readJson(record);
      assert.equal(stop.code, 78);
      assert.equal(stop.port, port);
      assert.equal(appStarts(a).length - before, 1, 'app.js started once');
      assert.equal(restarted.result, undefined, 'the daemon itself keeps running');
      return stop.message;
    });
    await check('daemon status shows why app.js is stopped', () => {
      const status = spawnSync(process.execPath, [path.join(dist, 'cli.js'), 'daemon', 'status'], { env: a.env, encoding: 'utf8' });
      assert.match(status.stdout, new RegExp(`Child: +stopped — Port ${port} is already in use`));
      return status.stdout.split('\n').find(line => line.includes('Child:'));
    });
  } finally {
    await new Promise(resolve => holder.close(resolve));
  }
  await check('once the port is free, a daemon restart brings it back', async () => {
    const restart = spawnSync(process.execPath, [path.join(dist, 'cli.js'), 'daemon', 'restart'], { env: a.env, encoding: 'utf8' });
    assert.equal(restart.status, 0, restart.stderr);
    await waitServing(a);
  });
}

/** Stop both daemons, then start them at the same moment. */
async function restartTogether(a, b) {
  await Promise.all([a.runner.stop(a.daemon), b.runner.stop(b.daemon)]);
  for (const home of [a, b]) fs.rmSync(path.join(home.root, 'start-hook.json'), { force: true });
  [a.daemon, b.daemon] = await Promise.all([startDaemon(a, 'daemon-together'), startDaemon(b, 'daemon-together')]);
  await check('both daemons started at once come up, each on its own port', async () => {
    await Promise.all([waitServing(a), waitServing(b)]);
    return [mainPort(a), mainPort(b)];
  });
}

const a = makeHome('a', 0);
const b = makeHome('b', 1);
try {
  await installBoth(a, b);
  await restartTogether(a, b);
  await checkIsolation(a, b);
  await checkPortTaken(a, a.daemon);
  saveJson(`${base}-results.json`, { ok: true, results });
  console.log(`All ${results.length} checks passed; results in ${base}-results.json`);
} catch (error) {
  saveJson(`${base}-results.json`, { ok: false, results, error: String(error?.stack ?? error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.all([a.runner.close(), b.runner.close()]);
}
