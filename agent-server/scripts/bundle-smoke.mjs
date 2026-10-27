// Usage: env -i PATH="$PATH" HOME=/tmp/cortex-bundle-test/os-home \
// CORTEX_HOME=/tmp/cortex-bundle-test/home node scripts/bundle-smoke.mjs /tmp/cortex-bundle-test/prefix
// Requires an initialized, credential-free home. Uses only loopback ports 17301-17304/17380.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const prefix = path.resolve(process.argv[2]);
const windows = process.platform === 'win32';
const root = path.join(prefix, windows ? 'node_modules/@cortex-agent/server' : 'lib/node_modules/@cortex-agent/server');
const home = process.env.CORTEX_HOME;
const testRoot = path.dirname(prefix);
assert(path.basename(testRoot).startsWith('cortex-bundle-'), 'Use a named isolated cortex-bundle-* directory');
for (const dir of [home, process.env.HOME]) {
  const relative = path.relative(testRoot, path.resolve(dir ?? '.'));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Homes must be inside the isolated test root');
}
const output = path.join(path.dirname(home), 'smoke');
fs.mkdirSync(output, { recursive: true });
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, CORTEX_HOME: home,
  ...(windows ? {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT, USERPROFILE: process.env.HOME,
    APPDATA: path.join(process.env.HOME, 'AppData/Roaming'), LOCALAPPDATA: path.join(process.env.HOME, 'AppData/Local'),
    TEMP: testRoot, TMP: testRoot,
  } : {}),
  CORTEX_TELEMETRY: '0', CORTEX_UI_HTTP: '1', CORTEX_PORT_FORWARD: '0',
  WEBHOOK_PORT: '17301', CORTEX_CLIENT_PORT: '17302', CORTEX_TUI_PORT: '17303',
  CORTEX_UI_PORT: '17304', CORTEX_CLIENT_HOST: '127.0.0.1',
  CORTEX_CLIENT_TOKEN: 'bundle-smoke-client-token', CORTEX_WEBHOOK_TOKEN: 'bundle-smoke-webhook-token',
};
Object.assign(process.env, env);
const checks = [];
async function check(name, fn) {
  try { const detail = await fn(); checks.push({ name, status: detail?.skip ? 'unverified' : 'pass', detail }); }
  catch (error) { checks.push({ name, status: 'fail', error: error.stack }); }
  console.log(name, checks.at(-1).status);
}
const load = rel => import(pathToFileURL(path.join(root, rel)).href);
function bin(name, args, expected = 0, options = {}) {
  const result = runBin(name, args, { timeout: 30000, ...options });
  fs.writeFileSync(path.join(output, `${name}-${args.join('_').replace(/[<>:"/\\|?*]/g, '-')}.log`), result.stdout + result.stderr);
  assert.equal(result.status, expected, result.stderr);
  return result.stdout.trim();
}
function runBin(name, args, options = {}) {
  const executable = windows ? path.join(prefix, `${name}.cmd`) : path.join(prefix, 'bin', name);
  return spawnSync(executable, args, { env, encoding: 'utf8', shell: windows, ...options });
}
for (const name of ['cortex', 'cortex-browser', 'cortex-evidence-export', 'cortex-hook', 'cortex-signal']) {
  await check(`${name} --help`, () => bin(name, ['--help']));
  const unsupported = { cortex: 1, 'cortex-evidence-export': 1, 'cortex-hook': 1, 'cortex-signal': 2 };
  await check(`${name} --version (existing CLI contract)`, () => {
    bin(name, ['--version'], unsupported[name] ?? 0);
    return unsupported[name] ? `Unsupported in the baseline CLI too; expected exit ${unsupported[name]}` : 'Version returned';
  });
}
await check('cortex daemon --version', () => bin('cortex', ['daemon', '--version']));
await check('cortex config / package and defaults paths', () => {
  const text = bin('cortex', ['config']); assert(text.includes(root)); return text;
});
await check('cortex auth status --json / provider scan', () => {
  const text = bin('cortex', ['auth', 'status', '--json']);
  assert(text.includes('"available": true')); return 'Pi runtime available; no credentials supplied';
});
await check('Pi SDK and private model resolver', async () => {
  const { loadPiSdk, loadPiDefaultModels } = await load('dist/core/pi-sdk.js');
  const sdk = await loadPiSdk(); const defaults = await loadPiDefaultModels();
  assert(Object.keys(defaults).length > 20);
  const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  const models = runtime.getModels();
  assert(models.length > 100); return { exports: Object.keys(sdk).length, defaults: Object.keys(defaults).length, models: models.length };
});
await check('All nine lazy OAuth modules (no login)', async () => {
  const oauth = await load('vendor/pi-ai/oauth-load.js');
  const names = Object.keys(oauth).filter(name => name.startsWith('load'));
  for (const name of names) assert.equal(typeof (await oauth[name]({})).login, 'function');
  assert.equal(names.length, 9); return names;
});
await check('Jiti TypeScript extension with virtual TypeBox', async () => {
  const file = path.join(home, 'bundle-smoke-extension.ts');
  fs.writeFileSync(file, `import { Type } from 'typebox';\nexport default function(pi: any) { pi.registerTool({name:'smoke',label:'Smoke',description:'Smoke',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'ok'}],details:{}})}); }`);
  const { loadExtensions } = await load('vendor/pi/dist/core/extensions/loader.js');
  const result = await loadExtensions([file], home);
  assert.deepEqual(result.errors, []); assert(result.extensions[0].tools.has('smoke'));
});
await check('QuickJS WASM codemode worker', async () => {
  const { executeCodemode } = await load('vendor/pi/dist/extensions/codemode/execute.js');
  const result = await executeCodemode('smoke', { code: 'console.log(6 * 7)' }, undefined, undefined, undefined);
  assert(!result.isError, JSON.stringify(result)); assert(JSON.stringify(result).includes('42')); return result;
});
await check('Photon WASM image resize worker', async () => {
  const { createRequire } = await import('node:module');
  const sharp = createRequire(pathToFileURL(path.join(root, 'package.json')))('sharp');
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const { resizeImage } = await load('vendor/pi/dist/utils/image-resize.js');
  const result = await resizeImage(bytes, 'image/png', { maxWidth: 16, maxHeight: 16 });
  assert.equal(result?.width, 16); return { width: result.width, height: result.height };
});
await check('Lazy Bedrock implementation (aborted, no credentials)', async () => {
  const { bedrockConverseStreamApi } = await load('vendor/pi-ai/bedrock.js');
  const result = await bedrockConverseStreamApi().streamSimple({
    id: 'invalid-smoke', provider: 'amazon-bedrock', api: 'bedrock-converse-stream', input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
  }, { messages: [] }, { signal: AbortSignal.abort(), region: 'us-east-1' }).result();
  assert.equal(result.stopReason, 'aborted'); assert(!/Cannot find|not defined|Dynamic require/.test(result.errorMessage));
  return result.errorMessage;
});
await check('Claude CLI auth probe through server spawn adapter', async () => {
  const { readClaudeAuthStatus } = await load('dist/domain/auth/cc-auth-cli.js');
  // Claude returns exit 1 when logged out. The adapter intentionally reports that as a typed error.
  try { const status = await readClaudeAuthStatus(); assert.equal(status.loggedIn, false); return status; }
  catch (error) {
    assert.equal(error.code, 'claude_auth_status_failed');
    if (error.message.includes('ENOENT')) return { skip: 'Claude CLI not installed on this runner' };
    return { loggedOut: true, error: error.message };
  }
});
await check('hook-cli list', () => bin('cortex-hook', ['list']));

const owned = new Set();
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (windows) {
    const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { env, encoding: 'utf8' });
    assert.equal(killed.status, 0, killed.stderr);
  } else child.kill('SIGTERM');
  for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await delay(100);
}
function start(rel, args = [], overrides = {}) {
  const child = spawn(process.execPath, [path.join(root, rel), ...args], { env: { ...env, ...overrides }, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
  owned.add(child);
  const log = fs.createWriteStream(path.join(output, `${path.basename(rel)}.log`));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.on('close', () => log.end());
  return child;
}
try {
  await check('MCP stdio initialize + tools/list', async () => {
    const child = start('dist/domain/mcp/bundled-server.js', [JSON.stringify(['cortex-core', 'cortex-feishu'])]);
    let data = ''; child.stdout.on('data', part => { data += part; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bundle-smoke', version: '1' } } }) + '\n');
    for (let i = 0; i < 100 && !data.includes('"id":1'); i++) await delay(100);
    assert(data.includes('"serverInfo"'), data);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    for (let i = 0; i < 100 && !data.includes('"id":2'); i++) await delay(100);
    assert(data.includes('"tools"'), data); await stop(child); return data;
  });
  // Refuse to bind occupied test ports rather than reuse anyone else's service.
  for (const port of [17301, 17302, 17303, 17304, 17380]) {
    await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
  }
  const preload = fileURLToPath(new URL('./bundle-smoke-preload.mjs', import.meta.url));
  const daemon = start('dist/entry/daemon.js', [], { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, CORTEX_BUNDLE_SMOKE_GATEWAY_PORT: '17380' });
  await check('Daemon forks app; web SPA served', async () => {
    for (let i = 0; i < 200; i++) {
      try { const response = await fetch('http://127.0.0.1:17304/'); const body = await response.text(); if (response.ok && body.includes('<html')) return { status: response.status, bytes: body.length }; } catch {}
      if (daemon.exitCode !== null) throw new Error(`Daemon exited ${daemon.exitCode}`);
      await delay(100);
    }
    throw new Error('Web UI did not become ready');
  });
  await check('curl SPA and public API', () => {
    for (const url of ['http://127.0.0.1:17304/', 'http://127.0.0.1:17304/api/ui/session']) {
      const result = spawnSync('curl', ['-fsS', url], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
    }
  });
  await check('HTTP API session probe', async () => {
    const response = await fetch('http://127.0.0.1:17304/api/ui/session'); assert.equal(response.status, 200); return response.json();
  });
  await check('Authenticated tRPC projects.list', async () => {
    const url = 'http://127.0.0.1:17304/trpc/projects.list?input=%7B%7D';
    const rejected = await fetch(url); assert.equal(rejected.status, 401);
    const response = await fetch(url, { headers: { 'x-cortex-token': env.CORTEX_CLIENT_TOKEN } });
    assert.equal(response.status, 200); const body = await response.json(); assert(body.result); return body;
  });
  await check('Bundled aistatus child health on remapped test port', async () => {
    const response = await fetch('http://127.0.0.1:17380/health'); assert.equal(response.status, 200); return response.text();
  });
  await check('TUI WebSocket upgrade', async () => {
    // Node's built-in WebSocket proves the upgrade; auth is exercised separately via HTTP.
    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:17303');
      const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 5000);
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket upgrade failed')); };
    });
  });
  await check('signal-cli rejects unknown waitpoint through isolated HTTP endpoint', () => {
    const result = runBin('cortex-signal', ['--id', 'bundle-smoke-missing', '--secret', 'not-a-secret', '--status', 'ok', '--url', 'http://127.0.0.1:17301/webhook/signal', '--no-spool'], { env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0); assert(!/ECONNREFUSED|Cannot find|not defined/.test(result.stderr));
    return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
  });
  if (process.env.CORTEX_BUNDLE_BROWSER === '1') {
    await check('cortex-browser real page and snapshot', () => {
      const options = { env: { ...env, CORTEX_SESSION_ID: 'bundle-browser-smoke' }, timeout: 60000 };
      try {
        bin('cortex-browser', ['open', 'data:text/html,<title>Bundle smoke</title><button>Smoke button</button>'], 0, options);
        const snapshot = bin('cortex-browser', ['snapshot', '-i'], 0, options);
        assert(snapshot.includes('Smoke button'), snapshot); return snapshot;
      } finally { bin('cortex-browser', ['close'], 0, options); }
    });
  }
  await stop(daemon);
  await check('Daemon and children stopped', async () => {
    for (const port of [17301, 17302, 17303, 17304, 17380]) {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); reject(new Error(`Port ${port} still open`)); });
        socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
      });
    }
  });
} finally {
  for (const child of owned) await stop(child);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2) + '\n');
}
if (checks.some(check => check.status === 'fail')) process.exitCode = 1;
