import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retireGatewayChild, type RetireGatewayOptions } from '../../src/store/retire-gateway-migration.js';

let home: string;
let storeDir: string;
let gatewayConfigPath: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-gateway-'));
  storeDir = path.join(home, 'data');
  fs.mkdirSync(storeDir);
  gatewayConfigPath = path.join(home, 'aistatus', 'gateway.yaml');
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
});

const pidFile = () => path.join(storeDir, 'gateway.pid');
const gatewayCommand = (extra = '') => `node /opt/cortex/node_modules/aistatus/dist/gateway-cli.js start -c ${gatewayConfigPath} -p 9880${extra}`;

/** A fake process table: each pid has a command line and a working directory. */
function fakes(table: Record<number, { command: string; cwd?: string }>, platform: NodeJS.Platform = 'linux') {
  const alive = new Set(Object.keys(table).map(Number));
  const signals: Array<[number, string]> = [];
  const options: Partial<RetireGatewayOptions> = {
    platform,
    commandLine: (pid) => (alive.has(pid) ? table[pid].command : null),
    workingDir: (pid) => table[pid]?.cwd ?? null,
    listPids: () => [...alive],
    isAlive: (pid) => alive.has(pid),
    signal: (pid, name) => { signals.push([pid, name]); alive.delete(pid); },
  };
  return { options, signals };
}

function retire(extra: Partial<RetireGatewayOptions>) {
  return retireGatewayChild({ storeDir, homeDir: home, gatewayConfigPath, ...extra });
}

describe('retiring the gateway an earlier server left running', () => {
  it('stops the gateway its pid file names and removes the pid file', async () => {
    fs.writeFileSync(pidFile(), '4242\n');
    const { options, signals } = fakes({ 4242: { command: gatewayCommand(` --pid-file ${pidFile()}`) } }, 'darwin');
    expect(await retire(options)).toEqual([4242]);
    expect(signals).toEqual([[4242, 'SIGTERM']]);
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('never stops a recycled pid: the command line must carry the gateway CLI and this pid file', async () => {
    fs.writeFileSync(pidFile(), '4242\n');
    const other = path.join(os.tmpdir(), 'another-install', 'gateway.pid');
    const { options, signals } = fakes({ 4242: { command: gatewayCommand(` --pid-file ${other}`), cwd: '/elsewhere' } });
    expect(await retire(options)).toEqual([]);
    const editor = fakes({ 4242: { command: 'vim notes.txt' } });
    expect(await retire(editor.options)).toEqual([]);
    expect([...signals, ...editor.signals]).toEqual([]);
  });

  it('on Linux, finds a gateway started before the pid file by its config and working directory', async () => {
    const { options, signals } = fakes({
      7: { command: gatewayCommand(), cwd: home },
      8: { command: gatewayCommand(), cwd: path.join(os.tmpdir(), 'another-home') },
      9: { command: 'node gateway-cli.js start -c /elsewhere/gateway.yaml -p 9881', cwd: home },
    });
    expect(await retire(options)).toEqual([7]);
    expect(signals).toEqual([[7, 'SIGTERM']]);
  });

  it('leaves processes alone elsewhere when there is no pid file', async () => {
    const { options, signals } = fakes({ 7: { command: gatewayCommand(), cwd: home } }, 'darwin');
    expect(await retire(options)).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('kills a gateway that ignores SIGTERM', async () => {
    fs.writeFileSync(pidFile(), '4242\n');
    const signals: string[] = [];
    let alive = true;
    const stopped = await retire({
      platform: 'darwin',
      commandLine: () => gatewayCommand(` --pid-file ${pidFile()}`),
      isAlive: () => alive,
      signal: (_pid, name) => { signals.push(name); if (name === 'SIGKILL') alive = false; },
    });
    expect(stopped).toEqual([4242]);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  }, 15_000);

  it('refuses to signal a real process from a test when no signaller is given', async () => {
    fs.writeFileSync(pidFile(), '4242\n');
    await expect(retire({ platform: 'darwin', commandLine: () => gatewayCommand(` --pid-file ${pidFile()}`) }))
      .rejects.toThrow(/refusing to signal/);
  });

  it.runIf(process.platform === 'linux')('stops a real process that carries the gateway command line', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'gateway-cli.js', 'start',
      '-c', gatewayConfigPath, '--pid-file', pidFile()], { cwd: home, stdio: 'ignore' });
    children.push(child);
    await new Promise((resolve) => child.once('spawn', resolve));
    fs.writeFileSync(pidFile(), `${child.pid}\n`);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const stopped = await retire({ signal: (pid, name) => process.kill(pid, name) });
    expect(stopped).toEqual([child.pid]);
    await exited;
  });
});
