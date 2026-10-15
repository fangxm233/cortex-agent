import { afterAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';

const children = new Set<ChildProcess>();
const homes: string[] = [];
afterAll(() => {
  for (const child of children) if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function isolatedEnvironment() {
  const home = mkdtempSync(join(tmpdir(), 'cortex-no-git-'));
  homes.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  // No Git, package managers, provider credentials, or access to the real home.
  const env = { PATH: bin, HOME: home, CORTEX_HOME: home, CORTEX_PLATFORM: 'test', NODE_ENV: 'test' };
  return { home, env };
}

function launch(entry: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/entry', entry), ...args], {
    env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  return { child, output: () => output, errors: () => errors };
}

async function initialize(home: string, env: NodeJS.ProcessEnv, port: number) {
  const answers = join(home, 'answers.json');
  writeFileSync(answers, JSON.stringify({ lang: 'en', backends: ['pi'], platforms: [],
    machineName: 'no-git', installService: false, localUi: { enabled: true, port } }));
  const run = launch('cli.ts', ['init', '--home', home, '--gateway-config-dir', join(home, '.aistatus'),
    '--answers', answers, '--json'], env);
  const [code] = await once(run.child, 'close');
  expect(code, run.errors()).toBe(0);
  expect(existsSync(join(home, '.git'))).toBe(false);
  expect(run.errors()).toContain('continuing without version history');
  const events = run.output().trim().split('\n').map(line => JSON.parse(line));
  return events.at(-1) as { clientToken: string; uiUrl: string };
}

async function waitForReady(run: ReturnType<typeof launch>) {
  const deadline = Date.now() + 60_000;
  while (!run.output().includes('Cortex agent is running') && Date.now() < deadline) {
    if (run.child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  expect(run.output(), run.errors()).toContain('Cortex agent is running');
  expect(run.output()).toContain('provider setup required');
  expect(run.errors()).not.toContain('unhandledRejection');
}

async function call(url: string, token: string, method: string, mutation = false) {
  const response = await fetch(`${url}/trpc/${method}${mutation ? '' : '?input=%7B%7D'}`, {
    method: mutation ? 'POST' : 'GET', body: mutation ? '{}' : undefined,
    headers: { 'x-cortex-token': token, 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json() as { result: { data: unknown } };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.result.data;
}
const query = (url: string, token: string, method: string) => call(url, token, method);
/** The Provider page's model refresh. */
const refreshModels = (url: string, token: string) => call(url, token, 'auth.syncGateway', true) as Promise<{
  configured: boolean; reason?: string; defaultSet: boolean; favorites: {backend:string;provider:string|null;model:string}[];
}>;

/** Model refresh before and after the first PI login, while no models.json exists yet. */
async function firstLoginRefresh(home: string, endpoint: { uiUrl: string; clientToken: string }) {
  expect(await refreshModels(endpoint.uiUrl, endpoint.clientToken)).toMatchObject({ configured: false, reason: 'no-endpoints' });
  mkdirSync(join(home, '.pi/agent'), { recursive: true });
  writeFileSync(join(home, '.pi/agent/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-test' } }));
  expect(await refreshModels(endpoint.uiUrl, endpoint.clientToken)).toMatchObject({ configured: true, defaultSet: true, favorites: [expect.objectContaining({ backend: 'pi', provider: 'openai' })] });
  expect(existsSync(join(home, 'config/models.json'))).toBe(true);
  const status = await query(endpoint.uiUrl, endpoint.clientToken, 'auth.status') as {
    accounts: { provider: string; inUse: boolean }[];
  };
  expect(status.accounts.filter(account => account.inUse).map(account => account.provider)).toEqual(['openai']);
}

test.skipIf(process.platform === 'win32')('Git-free init starts a real server and serves provider setup', async () => {
  const { home, env } = isolatedEnvironment();
  const endpoint = await initialize(home, env, await freePort());
  const run = launch('app.ts', [], { ...env,
    WEBHOOK_PORT: String(await freePort()), CORTEX_CLIENT_PORT: String(await freePort()), CORTEX_TUI_PORT: String(await freePort()),
  });
  await waitForReady(run);
  const status = await query(endpoint.uiUrl, endpoint.clientToken, 'auth.status') as {
    piRuntime: { available: boolean }; accounts: { inUse: boolean }[];
  };
  expect(status.piRuntime.available).toBe(true);
  expect(status.accounts.length).toBeGreaterThan(0);
  expect(status.accounts.every(account => !account.inUse)).toBe(true);
  expect(existsSync(join(home, 'config/models.json'))).toBe(false);
  expect(await query(endpoint.uiUrl, endpoint.clientToken, 'config.get')).toBeTruthy();
  await firstLoginRefresh(home, endpoint);
  expect(existsSync(join(home, '.git'))).toBe(false);
  const closed = once(run.child, 'close');
  run.child.kill('SIGTERM');
  expect((await closed)[0], run.errors()).toBe(0);
  expect(run.errors()).not.toMatch(/unhandledRejection|models unreadable/);
});
