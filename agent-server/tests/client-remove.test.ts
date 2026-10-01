import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RemoveClientError,
  buildRemoteCleanupCommand,
  clientHome,
  removeClient,
} from '../src/domain/remote/client-remove.js';
import { runClientCli } from '../src/entry/client-cli.js';

let root: string;
let configDir: string;
let storeDir: string;

const MACHINES = {
  hub: { cortexPath: '/srv/hub', gpuCount: 2 },
  trainer: {
    cortexPath: '/home/u', gpuCount: 4, ssh: 'u@trainer', clientConnection: 'ssh-reverse' as const, clientReversePort: 13002,
  },
  desk: { cortexPath: 'D:\\work', gpuCount: 0, ssh: 'u@desk', win: true },
};

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-client-remove-'));
  configDir = path.join(root, 'config');
  storeDir = path.join(root, 'data');
  fs.mkdirSync(configDir);
  fs.mkdirSync(storeDir);
  fs.writeFileSync(path.join(configDir, 'machines.json'), JSON.stringify(MACHINES, null, 2));
  fs.writeFileSync(path.join(storeDir, 'client-pids.json'), JSON.stringify({ hub: 11, trainer: 4321, desk: 77 }));
  fs.writeFileSync(path.join(storeDir, 'client-routes.json'), JSON.stringify({
    trainer: 'ws://127.0.0.1:13002', desk: 'direct',
  }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('a dry run reports the plan and touches nothing', async () => {
  const remoteExec = vi.fn();

  const report = await removeClient({ device: 'trainer', dryRun: true }, { configDir, storeDir, remoteExec });

  assert.equal(report.dry_run, true);
  assert.deepEqual(report.would_remove, {
    machine_entry: MACHINES.trainer,
    runtime: { pid: 4321, route: 'ws://127.0.0.1:13002' },
    remote: { host: 'u@trainer', home: '$HOME/.cortex' },
  });
  assert.equal(remoteExec.mock.calls.length, 0);
  assert.deepEqual(readJson(path.join(configDir, 'machines.json')), MACHINES);
  assert.equal(readJson(path.join(storeDir, 'client-pids.json')).trainer, 4321);
});

test('removal unregisters the machine, cleans the remote side, then drops runtime state', async () => {
  const order: string[] = [];
  const remoteExec = vi.fn(async (host: string) => {
    // The registry entry must be gone before the remote client dies, or the server relaunches it.
    order.push(readJson(path.join(configDir, 'machines.json')).trainer ? 'still-registered' : 'unregistered');
    assert.equal(host, 'u@trainer');
    return 'killed=4321\nfiles=removed\n';
  });

  const report = await removeClient({ device: 'trainer' }, { configDir, storeDir, remoteExec });

  assert.deepEqual(order, ['unregistered']);
  assert.deepEqual(report.remote, { status: 'cleaned', killed: '4321', files: 'removed' });
  assert.match(report.removed_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(readJson(path.join(configDir, 'machines.json'))), ['hub', 'desk']);
  assert.deepEqual(readJson(path.join(storeDir, 'client-pids.json')), { hub: 11, desk: 77 });
  assert.deepEqual(readJson(path.join(storeDir, 'client-routes.json')), { desk: 'direct' });
});

test('an unreachable machine is still removed locally and the failure is reported', async () => {
  const remoteExec = vi.fn(async () => { throw new Error('Could not resolve hostname trainer'); });

  const report = await removeClient({ device: 'trainer' }, { configDir, storeDir, remoteExec });

  assert.deepEqual(report.remote, { status: 'unreachable', error: 'Could not resolve hostname trainer' });
  assert.equal(readJson(path.join(configDir, 'machines.json')).trainer, undefined);
  assert.equal(readJson(path.join(storeDir, 'client-pids.json')).trainer, undefined);
});

test('--keep-remote leaves the remote machine alone', async () => {
  const remoteExec = vi.fn();

  const report = await removeClient({ device: 'desk', keepRemote: true }, { configDir, storeDir, remoteExec });

  assert.deepEqual(report.remote, { status: 'skipped' });
  assert.equal(remoteExec.mock.calls.length, 0);
  assert.equal(readJson(path.join(configDir, 'machines.json')).desk, undefined);
});

test('an unknown device fails and lists the removable machines', async () => {
  await assert.rejects(
    removeClient({ device: 'trainr' }, { configDir, storeDir, remoteExec: vi.fn() }),
    (error: RemoveClientError) => {
      assert.ok(error instanceof RemoveClientError);
      assert.match(error.message, /Unknown device: 'trainr'/);
      assert.deepEqual(error.validValues, ['trainer', 'desk']);
      return true;
    },
  );
});

test('the server-local machine is refused', async () => {
  await assert.rejects(
    removeClient({ device: 'hub' }, { configDir, storeDir, remoteExec: vi.fn() }),
    /'hub' is the server's local machine/,
  );
  assert.deepEqual(readJson(path.join(configDir, 'machines.json')), MACHINES);
});

test('the client home follows the bundle path in clientCommand and defaults per platform', () => {
  assert.equal(clientHome({ cortexPath: '/x', gpuCount: 0, ssh: 'h' }), '$HOME/.cortex');
  assert.equal(clientHome({ cortexPath: 'D:\\x', gpuCount: 0, ssh: 'h', win: true }), '%USERPROFILE%\\.cortex');
  assert.equal(clientHome({
    cortexPath: '/x', gpuCount: 0, ssh: 'h',
    clientCommand: '/usr/local/bin/node /data/home/.cortex/client/current/client.mjs',
  }), '/data/home/.cortex');
  assert.equal(clientHome({
    cortexPath: 'C:\\x', gpuCount: 0, ssh: 'h', win: true,
    clientCommand: 'node "C:\\Users\\Jo Doe\\.cortex\\client\\current\\client.mjs"',
  }), 'C:\\Users\\Jo Doe\\.cortex');
});

test('the Windows cleanup stops the client before keeping a server home, and never matches itself', () => {
  const command = buildRemoteCleanupCommand(MACHINES.desk);

  assert.match(command, /-like '\*%USERPROFILE%\\\.cortex\\client\\current\\client\[\.\]mjs\*'/);
  assert.match(command, /Stop-Process -Id \$_\.ProcessId -Force/);
  assert.match(command, / & if exist "%USERPROFILE%\\\.cortex\\config\\machines\.json" \(echo files=kept-server-home\) else \(/);
  assert.match(command, /rmdir \/s \/q "%USERPROFILE%\\\.cortex\\client"/);
  assert.match(command, /del \/q "%USERPROFILE%\\\.cortex\\config\\cortex-client\.json"/);
});

// --- The POSIX script, run for real against a throwaway home ---

function runScript(script: string, home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('sh', ['-c', script], { env: { ...process.env, HOME: home } }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function fakeClientHome(): { home: string; bundle: string } {
  const home = path.join(root, 'remote-home');
  const bundle = path.join(home, '.cortex', 'client', 'current', 'client.mjs');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.mkdirSync(path.join(home, '.cortex', 'config'));
  fs.mkdirSync(path.join(home, '.cortex', 'logs'));
  fs.mkdirSync(path.join(home, '.cortex', 'tmp'));
  fs.writeFileSync(bundle, 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(home, '.cortex', 'config', 'cortex-client.json'), '{}');
  fs.writeFileSync(path.join(home, '.cortex', 'logs', 'client-20261001.log'), 'log');
  fs.writeFileSync(path.join(home, '.cortex', 'tmp', 'keep.txt'), 'unrelated');
  return { home, bundle };
}

function startFakeClient(bundle: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [bundle], { stdio: 'ignore' });
  return new Promise((resolve) => setTimeout(() => resolve(child), 200));
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.signalCode ?? child.exitCode);
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
}

test.skipIf(process.platform !== 'linux')('the POSIX cleanup kills the client and removes only its files', async () => {
  const { home, bundle } = fakeClientHome();
  const client = await startFakeClient(bundle);

  const out = await runScript(buildRemoteCleanupCommand(MACHINES.trainer), home);

  assert.equal(await exited(client), 'SIGTERM');
  assert.match(out, new RegExp(`^killed=${client.pid}$`, 'm'));
  assert.match(out, /^files=removed$/m);
  assert.equal(fs.existsSync(path.join(home, '.cortex', 'client')), false);
  assert.equal(fs.existsSync(path.join(home, '.cortex', 'config')), false);
  assert.equal(fs.existsSync(path.join(home, '.cortex', 'logs')), false);
  assert.equal(fs.readFileSync(path.join(home, '.cortex', 'tmp', 'keep.txt'), 'utf8'), 'unrelated');
});

test.skipIf(process.platform !== 'linux')('the POSIX cleanup on a server home stops the client but keeps every file', async () => {
  const { home, bundle } = fakeClientHome();
  fs.writeFileSync(path.join(home, '.cortex', 'config', 'machines.json'), '{}');
  const client = await startFakeClient(bundle);

  const out = await runScript(buildRemoteCleanupCommand(MACHINES.trainer), home);

  assert.equal(await exited(client), 'SIGTERM');
  assert.match(out, new RegExp(`^killed=${client.pid}$`, 'm'));
  assert.match(out, /^files=kept-server-home$/m);
  assert.equal(fs.existsSync(bundle), true);
  assert.equal(fs.existsSync(path.join(home, '.cortex', 'config', 'cortex-client.json')), true);
});

// --- `cortex client remove` ---

test('the CLI prints the dry-run plan as JSON', async () => {
  const result = await runClientCli(['remove', '--device', 'trainer', '--dry-run', '--home', root]);

  assert.equal(result.exitCode, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.would_remove.remote.host, 'u@trainer');
  assert.equal(readJson(path.join(configDir, 'machines.json')).trainer.ssh, 'u@trainer');
});

test('the CLI removes a machine it cannot reach and warns about the remote side', async () => {
  const unreachable = async () => { throw new Error('Connection timed out'); };

  const result = await runClientCli(['remove', '--device', 'trainer', '--home', root], unreachable);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).remote.status, 'unreachable');
  assert.match(result.stderr, /could not be reached/);
  assert.equal(readJson(path.join(configDir, 'machines.json')).trainer, undefined);
});

test('the CLI rejects bad input with the valid alternatives', async () => {
  const cases: Array<[string[], RegExp]> = [
    [[], /Missing subcommand for 'client'\.\nValid values: remove/],
    [['rm', '--device', 'trainer'], /Unknown subcommand: 'rm'/],
    [['remove'], /Missing --device\./],
    [['remove', '--device'], /Missing value for --device\./],
    [['remove', '--device', 'trainer', '--force'], /Unknown option: '--force'\.\nValid values: --device, --home, --keep-remote, --dry-run/],
    [['remove', '--device', 'nope', '--home', root], /Unknown device: 'nope'\.\nValid values: trainer, desk/],
  ];
  for (const [args, expected] of cases) {
    const result = await runClientCli(args);
    assert.equal(result.exitCode, 1, args.join(' '));
    assert.match(result.stderr, expected);
  }
});

test('the CLI help carries copyable examples', async () => {
  const result = await runClientCli(['remove', '--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /cortex client remove --device trainer --dry-run/);
});
