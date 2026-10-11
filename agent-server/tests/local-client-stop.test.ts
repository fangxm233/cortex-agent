import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR, DATA_DIR, STORE_DIR } from '../src/core/paths.js';
import { processCommandLine } from '../src/core/process-command-line.js';
import { localClientEntryPath } from '../src/domain/remote/client-pids.js';
import { readLocalClientIntent } from '../src/domain/remote/local-client-install.js';
import {
  runsLocalClientEntry, stopLaunchedLocalClients, type LocalClientStopDeps,
} from '../src/domain/remote/local-client-stop.js';

const posix = process.platform !== 'win32';
const children: ChildProcess[] = [];
const pidsFile = path.join(STORE_DIR, 'client-pids.json');
const machinesFile = path.join(CONFIG_DIR, 'machines.json');
const intentFile = path.join(DATA_DIR, 'client', 'local-install.json');

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

/** A real process running this home's client bundle, like the one the daemon launches. */
function startLocalClient(): ChildProcess {
  fs.mkdirSync(path.dirname(localClientEntryPath()), { recursive: true });
  fs.writeFileSync(localClientEntryPath(), 'setInterval(() => {}, 1000);\n');
  return track(spawn(process.execPath, [localClientEntryPath()], { stdio: 'ignore' }));
}

function startSleeper(): ChildProcess {
  return track(spawn('sleep', ['60'], { stdio: 'ignore' }));
}

function exited(child: ChildProcess): Promise<unknown> {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitStarted(child: ChildProcess): Promise<void> {
  // The command line is readable once the exec has happened.
  for (let i = 0; i < 100 && !processCommandLine(child.pid!)?.includes(path.basename(localClientEntryPath())); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function writeOwnedIntent(device: string, launchAttempted: boolean): void {
  const config = JSON.stringify({ deviceName: device, serverHost: '127.0.0.1', serverPort: 3002 }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(intentFile), { recursive: true });
  fs.writeFileSync(intentFile, JSON.stringify({
    schema: 1, state: 'ready', device, launchAttempted,
    configHash: createHash('sha256').update(config).digest('hex'), bundleHash: 'a'.repeat(64),
  }));
}

function recordedPids(): Record<string, number> {
  return JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
}

beforeEach(() => {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const file of [pidsFile, machinesFile, intentFile]) fs.rmSync(file, { force: true });
});

test.skipIf(!posix)('stops the local client it launched and leaves SSH, custom-command and reused PIDs alone', async () => {
  const client = startLocalClient();
  const [ssh, reverse, custom, reused] = [startSleeper(), startSleeper(), startSleeper(), startSleeper()];
  await waitStarted(client);
  fs.writeFileSync(machinesFile, JSON.stringify({
    local: { cortexPath: DATA_DIR, gpuCount: 0 },
    'ssh-box': { cortexPath: '/remote', gpuCount: 0, ssh: 'ssh-box' },
    'reverse-box': { cortexPath: '/remote', gpuCount: 0, ssh: 'reverse-box', clientConnection: 'ssh-reverse' },
    'custom-box': { cortexPath: '/custom', gpuCount: 0, clientCommand: 'node /custom/client.mjs' },
    'other-local': { cortexPath: '/elsewhere', gpuCount: 0 },
  }));
  fs.writeFileSync(pidsFile, JSON.stringify({
    local: client.pid, 'ssh-box': ssh.pid, 'reverse-box': reverse.pid, 'custom-box': custom.pid, 'other-local': reused.pid,
  }));

  const stops = await stopLaunchedLocalClients();

  await exited(client);
  expect(stops).toEqual([
    { device: 'local', pid: client.pid, outcome: 'stopped' },
    { device: 'other-local', pid: reused.pid, outcome: 'reused' },
  ]);
  for (const child of [ssh, reverse, custom, reused]) expect(alive(child)).toBe(true);
  expect(recordedPids()).toEqual({ 'ssh-box': ssh.pid, 'reverse-box': reverse.pid, 'custom-box': custom.pid });
});

test.skipIf(!posix)('a stopped owned client lets the next start launch without waiting for a reconnect', async () => {
  const client = startLocalClient();
  await waitStarted(client);
  fs.writeFileSync(machinesFile, JSON.stringify({ local: { cortexPath: DATA_DIR, gpuCount: 0 } }));
  fs.writeFileSync(pidsFile, JSON.stringify({ local: client.pid }));
  writeOwnedIntent('local', true);

  expect(await stopLaunchedLocalClients()).toEqual([{ device: 'local', pid: client.pid, outcome: 'stopped' }]);

  expect(readLocalClientIntent({ DATA_DIR, CONFIG_DIR })?.launchAttempted).toBe(false);
  expect(recordedPids()).toEqual({});
});

function fakeDeps(overrides: Partial<LocalClientStopDeps>): LocalClientStopDeps {
  return {
    platform: 'linux',
    registry: () => ({ local: { cortexPath: DATA_DIR, gpuCount: 0 } }),
    alive: () => true,
    commandLine: () => `node ${localClientEntryPath()}`,
    terminate: vi.fn(),
    kill: vi.fn(),
    sleep: async () => {},
    ...overrides,
  };
}

test('a client whose command line cannot be read is left running with its records', async () => {
  fs.writeFileSync(pidsFile, JSON.stringify({ local: 4242 }));
  writeOwnedIntent('local', true);
  const deps = fakeDeps({ commandLine: () => null });

  expect(await stopLaunchedLocalClients(deps)).toEqual([{ device: 'local', pid: 4242, outcome: 'unverified' }]);

  expect(deps.terminate).not.toHaveBeenCalled();
  expect(recordedPids()).toEqual({ local: 4242 });
  expect(readLocalClientIntent({ DATA_DIR, CONFIG_DIR })?.launchAttempted).toBe(true);
});

test('a client that ignores the stop request is killed, and one that survives is reported', async () => {
  fs.writeFileSync(pidsFile, JSON.stringify({ local: 4242 }));
  let killed = false;
  const forced = fakeDeps({ alive: () => !killed, kill: vi.fn(() => { killed = true; }) });
  expect(await stopLaunchedLocalClients(forced)).toEqual([{ device: 'local', pid: 4242, outcome: 'stopped' }]);
  expect(forced.terminate).toHaveBeenCalledWith(4242);
  expect(forced.kill).toHaveBeenCalledWith(4242);

  fs.writeFileSync(pidsFile, JSON.stringify({ local: 4242 }));
  const stubborn = fakeDeps({});
  expect(await stopLaunchedLocalClients(stubborn)).toEqual([{ device: 'local', pid: 4242, outcome: 'survived' }]);
  expect(recordedPids()).toEqual({ local: 4242 });
});

test('an exited client only loses its record', async () => {
  fs.writeFileSync(pidsFile, JSON.stringify({ local: 4242 }));
  const deps = fakeDeps({ alive: () => false });
  expect(await stopLaunchedLocalClients(deps)).toEqual([{ device: 'local', pid: 4242, outcome: 'not-running' }]);
  expect(deps.terminate).not.toHaveBeenCalled();
  expect(recordedPids()).toEqual({});
});

test('Windows command lines match the client bundle regardless of case and slash direction', () => {
  const entry = 'C:\\Users\\Me\\.cortex\\client\\current\\client.mjs';
  const commandLine = '"C:\\Users\\Me\\.cortex\\runtime\\node-v24.21.0-win-x64\\node.exe" c:/users/me/.cortex/client/current/client.mjs';
  expect(runsLocalClientEntry(commandLine, entry, 'win32')).toBe(true);
  expect(runsLocalClientEntry(commandLine, entry, 'linux')).toBe(false);
  expect(runsLocalClientEntry('"C:\\node.exe" C:\\Users\\Me\\other\\client.mjs', entry, 'win32')).toBe(false);
});

test.skipIf(!posix)('processCommandLine reads a live process and returns null for an exited one', async () => {
  const sleeper = startSleeper();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(processCommandLine(sleeper.pid!)).toMatch(/sleep 60/);
  sleeper.kill('SIGKILL');
  await exited(sleeper);
  expect(processCommandLine(sleeper.pid!)).toBeNull();
  expect(processCommandLine(0)).toBeNull();
});
