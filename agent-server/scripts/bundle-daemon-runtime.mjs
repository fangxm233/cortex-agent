// Linux-only fixture lifecycle. No ambient credentials/config are inherited.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const SCENARIOS = ['rebuild', 'registry', 'startup-maps'];
export const now = () => Number(process.hrtime.bigint()) / 1e6;
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const saveJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

export function validateOptions(options) {
  assert(SCENARIOS.includes(options.scenario), `Invalid scenario: ${options.scenario}; choose ${SCENARIOS.join(', ')}`);
  assert.equal(process.platform, 'linux', 'Harness requires Linux /proc and process groups');
  for (const key of ['worktree', 'testroot', 'sourceTgz', 'bundleTgz']) {
    assert(path.isAbsolute(options[key] ?? ''), `${key} must be an explicit absolute path`);
  }
  for (const key of ['worktree', 'sourceTgz', 'bundleTgz']) assert(fs.existsSync(options[key]), `Missing ${key}: ${options[key]}`);
  assert(fs.existsSync(path.join(options.worktree, 'agent-server/package.json')), 'worktree must contain agent-server');
  assert(/^\/tmp\/cortex-bundle-[^/]+$/.test(options.testroot), 'testroot must be a fresh /tmp/cortex-bundle-* directory');
  if (options.scenario === 'startup-maps') assert(path.isAbsolute(options.mappedStage ?? ''), 'startup-maps requires mappedStage from the same --sourcemap bundle as bundleTgz');
  assert(!fs.existsSync(options.testroot), 'testroot already exists: choose a fresh root; previous results are never overwritten');
  return options;
}

export function claimRoot(root) {
  assert(/^\/tmp\/cortex-bundle-[^/]+$/.test(root), 'Use a fresh /tmp/cortex-bundle-* root');
  fs.mkdirSync(root, { mode: 0o700 });
  assert.equal(fs.realpathSync(root), root, 'Symlink roots are forbidden');
}

export function isolatedEnv(root, worktree, slot = 0) {
  const prefix = path.join(root, 'prefix');
  const home = path.join(root, 'home');
  const osHome = path.join(root, 'os-home');
  for (const dir of [prefix, home, osHome, path.join(root, 'tmp'), path.join(home, 'config'), path.join(home, 'data')]) fs.mkdirSync(dir, { recursive: true });
  const npmrc = path.join(root, 'npmrc');
  fs.writeFileSync(npmrc, '');
  const env = { PATH: `${prefix}/bin:${process.env.PATH}`, HOME: osHome, CORTEX_GATEWAY_HOME: osHome, CORTEX_HOME: home,
    CORTEX_NPM_PREFIX: prefix, npm_config_prefix: prefix, npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: npmrc, npm_config_globalconfig: path.join(root, 'global-npmrc'),
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_registry: 'https://registry.npmjs.org/', TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(osHome, '.config'), XDG_CACHE_HOME: path.join(osHome, '.cache'),
    CORTEX_TELEMETRY: '0', CORTEX_UI_HTTP: '1', CORTEX_PORT_FORWARD: '0', CI: '1',
    WEBHOOK_PORT: String(17401 + slot * 10), CORTEX_CLIENT_PORT: String(17402 + slot * 10),
    CORTEX_TUI_PORT: String(17403 + slot * 10), CORTEX_UI_PORT: String(17404 + slot * 10),
    CORTEX_CLIENT_HOST: '127.0.0.1', CORTEX_CLIENT_TOKEN: 'bundle-daemon-fixture-token',
    CORTEX_WEBHOOK_TOKEN: 'bundle-daemon-fixture-webhook', CORTEX_GATEWAY_PORT: String(9781 + slot),
    CORTEX_BUNDLE_TESTROOT: root, CORTEX_BUNDLE_EVENTS: path.join(root, 'events.jsonl'),
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(import.meta.dirname, 'bundle-daemon-preload.mjs')).href}` };
  fs.writeFileSync(env.npm_config_globalconfig, '');
  saveJson(path.join(home, 'config/settings.json'), { serverAutoUpdate: false, telemetryEnabled: false });
  fs.mkdirSync(path.join(osHome, '.aistatus'), { recursive: true });
  fs.writeFileSync(path.join(osHome, '.aistatus/gateway.yaml'), `host: 127.0.0.1\nport: ${env.CORTEX_GATEWAY_PORT}\n`);
  if (worktree) env.CORTEX_REPO = path.join(worktree, 'agent-server');
  return env;
}

export async function preflight(env) {
  const keys = ['WEBHOOK_PORT', 'CORTEX_CLIENT_PORT', 'CORTEX_TUI_PORT', 'CORTEX_UI_PORT', 'CORTEX_GATEWAY_PORT'];
  for (const key of keys) await checkPort(Number(env[key]));
}

function checkPort(port) {
  assert(port !== 9880 && port > 1023);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export function identity(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return { pid: Number(pid), state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}

export function sameProcess(a, b = identity(a?.pid)) {
  return Boolean(a && b && b.state !== 'Z' && a.pid === b.pid && a.start === b.start);
}

export async function waitFor(fn, label, timeoutMs = 120000) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms); inspect fixture logs`);
}

// Parent/group lineage is tracked without reading any other process's environment or files.
function descendants(roots) {
  const processes = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(identity).filter(Boolean);
  const live = roots.filter(item => sameProcess(item));
  const groups = new Set(live.filter(item => item.group !== process.pid && item.group !== identity(process.pid)?.group).map(item => item.group));
  const owned = new Map(live.map(item => [item.pid, item]));
  let previousSize = -1;
  while (previousSize !== owned.size) {
    previousSize = owned.size;
    for (const item of processes) if (owned.has(item.ppid) || groups.has(item.group)) owned.set(item.pid, item);
  }
  return [...owned.values()];
}

function recordedChildren(env) {
  if (!fs.existsSync(env.CORTEX_BUNDLE_EVENTS)) return [];
  return fs.readFileSync(env.CORTEX_BUNDLE_EVENTS, 'utf8').split('\n').slice(0, -1)
    .map(line => JSON.parse(line)).filter(event => event.type === 'process-start')
    .map(event => ({ pid: event.pid, start: event.identity })).filter(item => sameProcess(item))
    .map(item => identity(item.pid)).filter(Boolean);
}

function signalOwned(item, signal) {
  if (!sameProcess(item)) return;
  try { process.kill(item.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export function createRunner(root, env) {
  const owned = new Map();
  const handles = [];
  let closing;
  const track = () => descendants([...owned.values(), ...recordedChildren(env)]).forEach(item => owned.set(item.pid, item));
  const timer = setInterval(track, 100);
  const start = (command, args, label, overrides = {}) => {
    assert(!closing, 'Fixture runner is closing; refusing new subprocess');
    const logfile = path.join(root, `${label}.log`);
    const fd = fs.openSync(logfile, 'a');
    const child = spawn(command, args, { env: { ...env, ...overrides }, cwd: env.CORTEX_HOME,
      detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    const started = now();
    const entry = { child, identity: identity(child.pid), logfile, started, label };
    if (entry.identity) owned.set(child.pid, entry.identity);
    entry.done = completion(child, entry, root, command, args);
    handles.push(entry);
    return entry;
  };
  return { start, handles, track, stop: entry => stopTree(entry, owned),
    close: () => { clearInterval(timer); track(); closing ??= stopAll(owned, track); return closing; } };
}

function completion(child, entry, root, command, args) {
  return new Promise(resolve => {
    const finish = result => {
      if (entry.result) return;
      entry.result = { ...result, command, args, pid: child.pid, elapsedMs: now() - entry.started, logfile: entry.logfile };
      saveJson(path.join(root, `${entry.label}.result.json`), entry.result);
      resolve(entry.result);
    };
    child.once('error', error => finish({ code: null, error: error.message }));
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
}

async function stopAll(owned, track) {
  [...owned.values()].forEach(item => signalOwned(item, 'SIGTERM'));
  await delay(1500);
  track();
  const items = [...owned.values()].reverse();
  items.forEach(item => signalOwned(item, 'SIGKILL'));
  await waitFor(() => items.every(item => !sameProcess(item)), 'owned processes to exit', 5000);
}

async function stopTree(entry, owned) {
  const tree = descendants([entry.identity]);
  tree.forEach(item => owned.set(item.pid, item));
  signalOwned(entry.identity, 'SIGTERM');
  await delay(1500);
  tree.reverse().forEach(item => signalOwned(item, 'SIGKILL'));
  await waitFor(() => tree.every(item => !sameProcess(item)), 'owned daemon tree to exit', 5000);
}

export async function command(runner, executable, args, label, timeoutMs = 1200000, overrides = {}) {
  const entry = runner.start(executable, args, label, overrides);
  await waitFor(() => entry.result, label, timeoutMs);
  assert.equal(entry.result.code, 0, `${label} failed; see ${entry.logfile}`);
  return entry.result;
}
