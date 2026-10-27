// Fresh processes, warm OS file cache; no privileged cache drops. Never targets a live home.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: {
  sea: { type: 'string' }, cached: { type: 'string' }, node: { type: 'string' }, bundle: { type: 'string' },
  current: { type: 'string' }, 'current-node': { type: 'string', default: process.execPath }, output: { type: 'string' },
} });
for (const key of ['sea', 'node', 'bundle', 'output']) assert(values[key], `Missing --${key}`);
assert(process.env.CORTEX_HOME?.includes('cortex-sea-test') && process.env.HOME?.includes('cortex-sea-test'));
const home = process.env.CORTEX_HOME, out = path.resolve(values.output);
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, CORTEX_TELEMETRY: '0', CORTEX_UI_HTTP: '1', CORTEX_PORT_FORWARD: '0',
  WEBHOOK_PORT: '18301', CORTEX_CLIENT_PORT: '18302', CORTEX_TUI_PORT: '18303', CORTEX_UI_PORT: '18304',
  CORTEX_CLIENT_HOST: '127.0.0.1', CORTEX_BUNDLE_SMOKE_GATEWAY_PORT: '18380',
  CORTEX_CLIENT_TOKEN: 'sea-measure-token', CORTEX_WEBHOOK_TOKEN: 'sea-measure-hook' };
const preload = fileURLToPath(new URL('./sea-smoke-preload.mjs', import.meta.url));
const candidates = [
  { name: 'bundle-node26', command: values.node, root: values.bundle },
  { name: 'sea', command: values.sea },
  ...(values.cached ? [{ name: 'sea-code-cache', command: values.cached }] : []),
  ...(values.current ? [{ name: 'current-npm', command: values['current-node'], root: values.current }] : []),
];
function candidateEnv(candidate) {
  return { ...env, CORTEX_SEA_CACHE: path.join(out, `${candidate.name}-cache`) };
}
function args(candidate, entry, rest = []) {
  return [candidate.root ? path.join(candidate.root, entry) : '--entry=' + entry, ...rest];
}
function summary(samples) {
  return { median: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)], samples };
}
function help(candidate, extra = {}) {
  const start = performance.now();
  const child = spawnSync(candidate.command, args(candidate, 'dist/entry/cortex-cli.js', ['--help']), {
    env: { ...candidateEnv(candidate), ...extra }, cwd: home, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  return Math.round((performance.now() - start) * 10) / 10;
}
async function freePorts() {
  for (const port of [18301, 18302, 18303, 18304, 18380]) {
    await new Promise((resolve, reject) => {
      const server = net.createServer(); server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
  }
}
async function ready(child) {
  for (let i = 0; i < 300; i++) {
    assert.equal(child.exitCode, null, `Daemon exited ${child.exitCode}`);
    try { if ((await fetch('http://127.0.0.1:18304/api/ui/session')).ok) return; } catch {}
    await delay(20);
  }
  throw new Error('Daemon startup timed out');
}
function rss(pid) {
  if (process.platform === 'linux') return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) * 1024;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).WorkingSet64`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return Number(result.stdout.trim());
}
async function stop(child) {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
  else child.kill('SIGTERM');
  for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
  await delay(300);
  assert(child.exitCode !== null || child.signalCode !== null, 'Owned daemon failed to stop');
  await freePorts();
}
async function daemon(candidate, iteration) {
  await freePorts();
  const start = performance.now();
  const child = spawn(candidate.command, args(candidate, 'dist/entry/daemon.js'), {
    env: { ...candidateEnv(candidate), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    detached: process.platform !== 'win32', cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(out, `${candidate.name}-${iteration}.log`));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  try {
    await ready(child); const readyMs = Math.round((performance.now() - start) * 10) / 10;
    await delay(2500);
    const appPid = fs.readFileSync(path.join(home, 'data/daemon-child.pid'), 'utf8').trim();
    return { readyMs, appRssBytes: rss(appPid), daemonRssBytes: rss(child.pid) };
  } finally { try { await stop(child); } finally { log.end(); } }
}
const results = Object.fromEntries(candidates.map(candidate => [candidate.name, { helpMs: [], readyMs: [], appRssBytes: [], daemonRssBytes: [] }]));
const freshCache = path.join(out, 'fresh-cache');
assert(!fs.existsSync(freshCache), 'First-extraction measurement requires an unused cache');
const firstExtractionHelpMs = help(candidates[1], { CORTEX_SEA_CACHE: freshCache });
for (const candidate of candidates) help(candidate);
for (let i = 0; i < 9; i++) {
  for (const candidate of i % 2 ? [...candidates].reverse() : candidates) results[candidate.name].helpMs.push(help(candidate));
}
for (let i = 0; i < 5; i++) {
  for (const candidate of i % 2 ? [...candidates].reverse() : candidates) {
    const sample = await daemon(candidate, i);
    for (const [key, value] of Object.entries(sample)) results[candidate.name][key].push(value);
  }
}
const report = { platform: process.platform, firstExtractionHelpMs, note: 'Fresh processes, OS cache warm; ready = HTTP session API; RSS after 2.5 seconds idle',
  candidates, results: Object.fromEntries(Object.entries(results).map(([name, metrics]) => [name, Object.fromEntries(Object.entries(metrics).map(([key, samples]) => [key, summary(samples)]))])) };
fs.writeFileSync(path.join(out, 'measure.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
