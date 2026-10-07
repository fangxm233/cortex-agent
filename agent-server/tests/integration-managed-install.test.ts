import { afterAll, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Explicit artifact inputs: this test never installs into the operator's npm prefix or home.
const nodeDir = process.env.CORTEX_TEST_NODE_DIR;
const tarball = process.env.CORTEX_TEST_SERVER_TGZ;
const output = process.env.CORTEX_TEST_OUTPUT_DIR;
const enabled = process.platform === 'linux' && !!nodeDir && !!tarball;
interface Fixture { home: string; prefix: string; node: string; cli: string; env: NodeJS.ProcessEnv }
const fixtures: Fixture[] = [];

afterAll(async () => {
  for (const fixture of fixtures) await stopDaemon(fixture);
});

async function unusedPort(): Promise<string> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? String(address.port) : '';
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

function command(f: Fixture, args: string[], timeout = 30_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(f.node, args, { cwd: f.home, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`command timed out: ${args[0]}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

function restrictedTools(root: string): string {
  const bin = join(root, 'system-tools');
  mkdirSync(bin);
  for (const name of ['sh', 'bash', 'env', 'uname', 'hostname', 'which', 'dirname', 'readlink', 'cat', 'mkdir', 'cp', 'rm', 'chmod', 'ln', 'sleep', 'ps', 'kill']) {
    const source = `/usr/bin/${name}`;
    if (existsSync(source)) symlinkSync(source, join(bin, name));
  }
  expect(existsSync(join(bin, 'node'))).toBe(false);
  expect(existsSync(join(bin, 'npm'))).toBe(false);
  expect(existsSync(join(bin, 'git'))).toBe(false);
  return bin;
}

async function fixture(): Promise<Fixture> {
  const base = output ? resolve(output) : tmpdir();
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, 'managed install '));
  const prefix = join(home, '.cortex/runtime/npm');
  const node = join(resolve(nodeDir!), 'bin/node');
  const cli = join(prefix, 'lib/node_modules/@cortex-agent/server/dist/entry/cortex-cli.js');
  const env = { HOME: home, CORTEX_HOME: join(home, '.cortex'), CORTEX_NPM_PREFIX: prefix,
    PATH: [dirname(node), join(prefix, 'bin'), restrictedTools(home)].join(':'),
    CORTEX_PLATFORM: 'test', CORTEX_UI_PORT: await unusedPort(),
    WEBHOOK_PORT: await unusedPort(), CORTEX_CLIENT_PORT: await unusedPort(), CORTEX_TUI_PORT: await unusedPort(),
    npm_config_cache: join(home, 'npm-cache'), LANG: 'C.UTF-8' };
  const result = { home, prefix, node, cli, env };
  fixtures.push(result);
  return result;
}

async function install(f: Fixture) {
  const npm = join(resolve(nodeDir!), 'lib/node_modules/npm/bin/npm-cli.js');
  const installed = await command(f, [npm, 'install', '-g', '--prefix', f.prefix, resolve(tarball!), '--no-audit', '--no-fund'], 240_000);
  writeFileSync(join(f.home, 'npm-install.log'), installed.stdout + installed.stderr);
  expect(installed.code, installed.stderr).toBe(0);
  expect(existsSync(f.cli)).toBe(true);
  const probe = await command(f, ['-e', 'console.log(JSON.stringify({node:process.execPath,prefix:process.env.CORTEX_NPM_PREFIX}))']);
  expect(JSON.parse(probe.stdout)).toEqual({ node: realpathSync(f.node), prefix: f.prefix });
}

async function initialize(f: Fixture) {
  const answers = join(f.home, 'answers.json');
  writeFileSync(answers, JSON.stringify({ lang: 'en', backends: ['pi'], platforms: [], machineName: 'managed-install-test',
    installService: false, localUi: { enabled: true, port: Number(f.env.CORTEX_UI_PORT) } }));
  const result = await command(f, [f.cli, 'init', '--answers', answers, '--json', '--gateway-config-dir', join(f.home, '.aistatus')]);
  expect(result.code, result.stderr).toBe(0);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  const endpoint = events.at(-1) as { uiUrl: string; clientToken: string };
  expect(endpoint.uiUrl).toBe(`http://127.0.0.1:${f.env.CORTEX_UI_PORT}`);
  expect(existsSync(join(f.env.CORTEX_HOME!, '.git'))).toBe(false);
  return endpoint;
}

async function waitUntil<T>(action: () => Promise<T>, message: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { return await action(); } catch (error) { last = error; }
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`${message}: ${String(last)}`);
}

async function query(endpoint: { uiUrl: string; clientToken: string }, method: string) {
  const response = await fetch(`${endpoint.uiUrl}/trpc/${method}?input=%7B%7D`, {
    headers: { 'x-cortex-token': endpoint.clientToken }, signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(200);
  return (await response.json() as { result: { data: unknown } }).result.data;
}

async function startDaemon(f: Fixture) {
  const started = await command(f, [f.cli, 'daemon']);
  expect(started.code, started.stderr).toBe(0);
  await waitUntil(async () => {
    const pid = Number(readFileSync(join(f.env.CORTEX_HOME!, 'data/daemon.pid'), 'utf8'));
    expect(realpathSync(`/proc/${pid}/exe`)).toBe(realpathSync(f.node));
    const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    expect(env).toContain(`CORTEX_HOME=${f.env.CORTEX_HOME}`);
    expect(env).toContain(`CORTEX_NPM_PREFIX=${f.prefix}`);
    return pid;
  }, 'managed daemon environment');
}

async function stopDaemon(f: Fixture) {
  const pidFile = join(f.env.CORTEX_HOME!, 'data/daemon.pid');
  if (!existsSync(pidFile) || !existsSync(f.cli)) return;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try { if (realpathSync(`/proc/${pid}/exe`) !== realpathSync(f.node)) return; } catch { return; }
  const stopped = await command(f, [f.cli, 'daemon', 'stop']);
  expect(stopped.code, stopped.stderr).toBe(0);
}

test.skipIf(!enabled)('thin package installs and restarts a real daemon with only its selected Node/npm', async () => {
  const f = await fixture();
  await install(f);
  const endpoint = await initialize(f);
  for (let launch = 0; launch < 2; launch++) {
    await startDaemon(f);
    const auth = await waitUntil(() => query(endpoint, 'auth.status'), 'provider readiness') as { piRuntime: { available: boolean } };
    expect(auth.piRuntime.available).toBe(true);
    expect(await query(endpoint, 'config.get')).toBeTruthy();
    await stopDaemon(f);
  }
  writeFileSync(join(f.home, 'verification.json'), JSON.stringify({ ok: true, tarball: resolve(tarball!),
    node: f.node, prefix: f.prefix, daemonLaunches: 2, providerReady: true }, null, 2));
}, 300_000);
