// input:  fixture mode, pinned env, workspace/log/host paths
// output: controlled clean, host-write, listen, or connect syscalls
// pos:    Real strace target for access-probe integration tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

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

const actions = {
  clean: writeAllowedFiles,
  'host-write': writeHostFile,
  listen: listenOnce,
  connect: connectOnce,
};

const action = actions[mode];
if (!action) throw new Error(`unknown fixture mode: ${mode}`);
await action();
