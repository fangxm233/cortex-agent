// input:  mode, pinned env, workspace/log/host paths
// output: file, network, tamper, and timeout syscalls
// pos:    Access-probe integration target
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [mode, logsDir, hostPath] = process.argv.slice(2);

function writeAllowedFiles() {
  fs.writeFileSync(path.join(process.cwd(), 'workspace-result.txt'), 'workspace');
  fs.mkdirSync(path.join(process.env.CORTEX_HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CORTEX_HOME, 'data/clean.json'), '{}');
  fs.writeFileSync(path.join(logsDir, 'fixture.log'), 'clean');
}

function writeHostFile() {
  fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  fs.writeFileSync(hostPath, 'forbidden');
}

function listenOnce() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => server.close(error => (
      error ? reject(error) : resolve()
    )));
  });
}

function connectOnce() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 9 });
    socket.once('connect', () => socket.end(resolve));
    socket.once('error', () => resolve());
  });
}

function accessTransientSymlink() {
  const link = path.join(process.cwd(), 'ephemeral-link');
  fs.symlinkSync(hostPath, link);
  fs.statSync(link);
  fs.unlinkSync(link);
}

function forgeVisibleTraces() {
  const traces = fs.readdirSync(logsDir).filter(name => name.startsWith('access.trace.'));
  traces.forEach((name, index) => fs.renameSync(
    path.join(logsDir, name), path.join(logsDir, `hidden-trace-${index}`),
  ));
  fs.writeFileSync(path.join(logsDir, 'access.trace.999999'),
    `1.0 access("${process.cwd()}/forged", F_OK) = -1 ENOENT (No such file or directory)\n`);
  writeHostFile();
}

function spawnDetachedAndWait() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  fs.writeFileSync(path.join(process.cwd(), 'descendant.pid'), String(child.pid));
  child.unref();
  return new Promise(() => {});
}

const actions = {
  clean: writeAllowedFiles,
  'host-write': writeHostFile,
  'ephemeral-symlink': accessTransientSymlink,
  'trace-tamper': forgeVisibleTraces,
  'detached-timeout': spawnDetachedAndWait,
  listen: listenOnce,
  connect: connectOnce,
};

const action = actions[mode];
if (!action) throw new Error(`unknown fixture mode: ${mode}`);
await action();
