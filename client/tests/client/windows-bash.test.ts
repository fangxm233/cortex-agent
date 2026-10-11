import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execBash, execBashBackground } from '../../src/command-exec.js';

const SELECTED = 'D:\\Cortex 用户\\Portable Git\\bin\\bash.exe';
const STANDARD = 'C:\\Program Files\\Git\\bin\\bash.exe';
const PATH_BASH = 'E:\\Other Git\\bin\\bash.exe';
const TOOL_PATH = 'D:\\Cortex 用户\\node;D:\\Cortex 用户\\Portable Git\\cmd;E:\\Other Git\\bin';
const command = 'printf "%s\\n" "你好" | sort; exit 7';
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalEnv = process.env;
const signals = new Map(['SIGINT', 'SIGTERM'].map(s => [s, process.listeners(s)]));
const available = new Set<string>();
const spawns: { file: string; args: string[]; options: childProcess.SpawnOptions }[] = [];
const probeOptions: { file: string; options: childProcess.ExecFileSyncOptions }[] = [];
let probes = 0;
let socket: FakeSocket;

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: any[] = [];
  constructor() { super(); socket = this; }
  send(frame: string): void { this.sent.push(JSON.parse(frame)); }
}

function fakeSpawn(file: string, args: string[], options: childProcess.SpawnOptions) {
  spawns.push({ file, args, options });
  const proc = Object.assign(new EventEmitter(), {
    pid: 4321, stdout: new PassThrough(), stderr: new PassThrough(), unref() {},
  });
  queueMicrotask(() => proc.emit('close', 0));
  return proc;
}

async function dispatch(action: string, params: object): Promise<any> {
  socket.sent.length = 0;
  socket.emit('message', JSON.stringify({ type: 'command', commandId: 'fixture', action, params }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].type, 'result');
  assert.equal(socket.sent[0].commandId, 'fixture');
  return socket.sent[0];
}

function assertSelectedSpawn(login: boolean): void {
  assert.equal(spawns.length, 1, 'no qualification shell/probe is executed');
  assert.equal(probes, 0, 'no profile-sourcing qualification probe');
  assert.equal(spawns[0].file, SELECTED);
  assert.deepEqual(spawns[0].args.slice(0, login ? 2 : 1), login ? ['-l', '-c'] : ['-c']);
  assert.deepEqual(spawns[0].options.env, process.env, 'selected Node/npm/Git PATH and user script env inherited unchanged');
  assert.equal(spawns[0].options.env?.Path, TOOL_PATH);
  assert.equal(spawns[0].options.windowsHide, true, 'the console-less client must not open a console window');
}

before(async () => {
  mock.module('ws', { defaultExport: FakeSocket });
  mock.module('../../src/log.ts', {
    namedExports: { createLogger: () => ({ info() {}, warn() {}, error() {} }) },
  });
  const readFile = fs.readFileSync;
  mock.method(fs, 'readFileSync', (file: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (String(file).endsWith('cortex-client.json')) return JSON.stringify({ serverUrl: 'ws://fixture.invalid', clientToken: 'fixture' });
    return (readFile as any)(file, ...args);
  });
  mock.method(fs, 'existsSync', (file: fs.PathLike) => available.has(String(file)));
  mock.method(childProcess, 'spawn', fakeSpawn);
  mock.method(childProcess, 'execFileSync', (file: string, _args: string[], options: childProcess.ExecFileSyncOptions) => {
    probes++;
    probeOptions.push({ file, options });
    throw new Error('No real subprocess probes allowed');
  });
  syncBuiltinESMExports();
  process.env = { CORTEX_HOME: '/unused-client-fixture', Path: TOOL_PATH };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  await import('../../src/client.js');
});

beforeEach(() => {
  process.env = { CORTEX_HOME: '/unused-client-fixture', Path: TOOL_PATH, CORTEX_GIT_BASH_PATH: SELECTED, BASH_ENV: '/user/chosen-script' };
  available.clear();
  [SELECTED, STANDARD, PATH_BASH, 'C:\\fixture'].forEach(p => available.add(p));
  spawns.length = 0;
  probeOptions.length = 0;
  probes = 0;
  Object.defineProperty(process, 'platform', { value: 'win32' });
});

after(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  process.env = originalEnv;
  for (const [signal, prior] of signals) {
    for (const listener of process.listeners(signal)) {
      if (!prior.includes(listener)) process.removeListener(signal, listener);
    }
  }
  mock.restoreAll();
  syncBuiltinESMExports();
});

describe('selected Windows Git Bash at the client command boundary (no real sockets/processes)', () => {
  it('foreground prefers the exact selected path, preserving login flags, command and environment', async () => {
    const result = await dispatch('bash', { command });
    assert.equal(result.success, true);
    assertSelectedSpawn(true);
    assert.deepEqual(spawns[0].args, ['-l', '-c', command]);
    assert.equal(spawns[0].options.detached, false);
  });

  it('background uses the same selected resolver and preserves login semantics', async () => {
    const result = await dispatch('bash', { command, run_in_background: true });
    assert.equal(result.success, true);
    assert.equal(result.data.stdout, 'Background process started with PID 4321');
    assertSelectedSpawn(true);
    assert.deepEqual(spawns[0].args, ['-l', '-c', command]);
    assert.equal(spawns[0].options.detached, true);
    assert.equal(spawns[0].options.stdio, 'ignore');
  });

  it('glob uses the selected resolver without adding login/profile sourcing', async () => {
    const result = await dispatch('glob', { pattern: '**/*.ts', path: 'C:\\fixture' });
    assert.equal(result.success, true);
    assertSelectedSpawn(false);
    assert.deepEqual(spawns[0].args.slice(2), ['--', 'C:\\fixture', '**/*.ts']);
  });

  for (const action of ['foreground', 'background', 'glob']) {
    it(`${action} clearly fails a missing selected Bash without falling back`, async () => {
      available.delete(SELECTED);
      const result = await dispatch(action === 'glob' ? 'glob' : 'bash', {
        command, run_in_background: action === 'background', pattern: '*', path: 'C:\\fixture',
      });
      const error = result.error ?? result.data?.stderr ?? '';
      assert.match(error, /CORTEX_GIT_BASH_PATH/);
      assert.ok(error.includes(SELECTED));
      assert.ok(result.success === false || result.data?.exitCode === 127);
      assert.equal(spawns.length, 0);
    });
  }

  it('an explicitly empty selection is not treated as absent', async () => {
    process.env.CORTEX_GIT_BASH_PATH = '';
    const result = await dispatch('bash', { command });
    assert.match(result.error ?? result.data?.stderr ?? '', /CORTEX_GIT_BASH_PATH/);
    assert.equal(spawns.length, 0);
  });

  it('retains standard Git discovery when selection is absent', async () => {
    delete process.env.CORTEX_GIT_BASH_PATH;
    await execBash(command, 1000);
    assert.equal(spawns[0].file, STANDARD);
  });

  it('retains the second standard Git location', async () => {
    delete process.env.CORTEX_GIT_BASH_PATH;
    available.delete(STANDARD);
    const alternate = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
    available.add(alternate);
    execBashBackground(command);
    assert.equal(spawns[0].file, alternate);
  });

  for (const key of ['Path', 'PATH']) {
    it(`discovers Bash on Windows ${key} when selection/standard installs are absent`, async () => {
      process.env = { [key]: TOOL_PATH };
      available.delete(STANDARD);
      const result = await execBash(command, 1000);
      assert.equal(result.exitCode, 0);
      assert.equal(spawns[0].file, PATH_BASH);
      assert.deepEqual(spawns[0].options.env, process.env);
    });
  }

  for (const action of ['background', 'glob']) {
    it(`${action} uses PATH discovery without a selected or standard install`, async () => {
      delete process.env.CORTEX_GIT_BASH_PATH;
      available.delete(STANDARD);
      const result = await dispatch(action === 'glob' ? 'glob' : 'bash', {
        command, run_in_background: action === 'background', pattern: '*', path: 'C:\\fixture',
      });
      assert.equal(result.success, true);
      assert.equal(spawns[0]?.file, PATH_BASH);
    });
  }

  it('retains the foreground not-found result when no Bash can be discovered', async () => {
    delete process.env.CORTEX_GIT_BASH_PATH;
    available.clear();
    const result = await execBash(command, 1000);
    assert.equal(result.exitCode, 127);
    assert.match(result.stderr, /bash not found/);
    assert.equal(spawns.length, 0);
  });

  it('grep runs rg without a console window', async () => {
    const result = await dispatch('grep', { pattern: 'needle', path: 'C:\\fixture' });
    assert.equal(result.success, true);
    assert.equal(spawns[0].file, 'rg');
    assert.equal(spawns[0].options.windowsHide, true);
  });

  it('hello reports the client PID and its startup probes open no console window', async () => {
    socket.sent.length = 0;
    socket.emit('open');
    const hello = socket.sent.find(frame => frame.type === 'hello');
    assert.equal(hello?.pid, process.pid);
    assert.deepEqual(probeOptions.map(probe => probe.file).sort(), ['nvidia-smi', 'rg']);
    for (const probe of probeOptions) assert.equal(probe.options.windowsHide, true, probe.file);
  });

  it('a self-update successor is spawned without a console window', async () => {
    const { defaultRespawn } = await import('../../src/self-update.js');
    defaultRespawn('C:\\fixture\\client.mjs');
    assert.equal(spawns[0].file, process.execPath);
    assert.equal(spawns[0].options.detached, true);
    assert.equal(spawns[0].options.windowsHide, true);
  });

  it('leaves the inherited environment untouched after every execution mode', async () => {
    const inherited = { ...process.env };
    await dispatch('bash', { command });
    await dispatch('bash', { command, run_in_background: true });
    await dispatch('glob', { pattern: '*', path: 'C:\\fixture' });
    assert.deepEqual(process.env, inherited);
  });

  for (const platform of ['linux', 'darwin']) {
    it(`ignores the Windows selection on ${platform}`, async () => {
      Object.defineProperty(process, 'platform', { value: platform });
      available.clear();
      await execBash(command, 1000);
      assert.equal(spawns[0].file, '/bin/bash');
      assert.deepEqual(spawns[0].args, ['-l', '-c', command]);
      assert.deepEqual(spawns[0].options.env, process.env);
    });

    it(`preserves PATH-based non-login glob execution on ${platform}`, async () => {
      Object.defineProperty(process, 'platform', { value: platform });
      await dispatch('glob', { pattern: '*', path: 'C:\\fixture' });
      assert.equal(spawns[0].file, 'bash');
      assert.equal(spawns[0].args[0], '-c');
    });
  }
});
