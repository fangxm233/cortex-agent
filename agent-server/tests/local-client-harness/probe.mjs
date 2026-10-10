// No product import or startup until every isolation assertion passes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const out = '/home/tester/.harness';
const boundary = JSON.parse(fs.readFileSync('/harness/boundary.json', 'utf8'));
const names = ['user', 'pid', 'net', 'mnt', 'ipc', 'uts'];

function namespaceProof() {
  const identities = Object.fromEntries(names.map(n => [n, fs.readlinkSync(`/proc/self/ns/${n}`)]));
  for (const n of names) assert.notEqual(identities[n], boundary.hostNamespaces[n]);
  assert.equal(fs.readlinkSync('/proc/1/ns/pid'), identities.pid);
  assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
  assert(!fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)
    .some(line => line.trim().split(/\s+/)[1] === '00000000'));
  return identities;
}

function filesProof() {
  for (const file of ['.cortex', '.ssh', '.bash_profile', '.profile', '.npmrc']) {
    assert(!fs.existsSync(`${boundary.hostHome}/${file}`));
    assert(!fs.existsSync(`/proc/1/root${boundary.hostHome}/${file}`));
  }
  assert(!fs.existsSync('/root/.cortex'));
  assert(!fs.existsSync('/home/tester/.cortex/client'));
  assert.equal(fs.readFileSync('/etc/passwd', 'utf8').trim().split('\n').length, 1);
  assert(fs.readFileSync('/etc/passwd', 'utf8').includes('/home/tester:/bin/bash'));
  assert.equal(fs.readFileSync('/etc/resolv.conf', 'utf8'), '');
  assert.throws(() => fs.writeFileSync('/inputs/node/.isolation-write', 'no'), { code: 'EROFS' });
  assert.throws(() => fs.writeFileSync('/etc/profile', 'no'), { code: 'EROFS' });
  assert.throws(() => fs.writeFileSync('/root-write', 'no'), { code: 'EROFS' });
  const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
    .map(line => line.split(' '));
  for (const root of boundary.dependencyRoots) {
    assert(mounts.some(fields => fields[4] === root && fields[5].split(',').includes('ro')));
  }
}

function environmentProof() {
  const forbidden = /token|api_key|proxy|CORTEX_REPO|NODE_OPTIONS|BASH_ENV|ENV$|PYTHONPATH/i;
  assert.deepEqual(Object.keys(process.env).filter(k => forbidden.test(k)), []);
  const script = 'console.log(JSON.stringify({node:process.execPath,home:process.env.HOME,path:process.env.PATH}))';
  const result = JSON.parse(execFileSync('/bin/bash', ['-lc', `node -e '${script}'`], { encoding: 'utf8' }));
  assert.equal(result.node, '/inputs/node/bin/node');
  assert.equal(result.home, '/home/tester');
  assert.equal(result.path, '/inputs/node/bin:/usr/bin:/bin');
  return result;
}

async function refused(port) {
  const code = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500, () => { socket.destroy(); resolve('timeout'); });
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', error => resolve(error.code));
  });
  assert.equal(code, 'ECONNREFUSED');
}

async function localRoundtrip(port) {
  const server = net.createServer(socket => socket.end('private-loopback'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const text = await new Promise((resolve, reject) => {
    let data = '';
    const socket = net.connect(port, '127.0.0.1');
    socket.on('data', part => { data += part; });
    socket.once('end', () => resolve(data));
    socket.once('error', reject);
  });
  await new Promise(resolve => server.close(resolve));
  assert.equal(text, 'private-loopback');
}

async function main() {
  const namespaces = namespaceProof();
  filesProof();
  const login = environmentProof();
  for (const port of new Set([boundary.sentinelPort, 9880, 3004])) {
    await refused(port);
    await localRoundtrip(port);
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  fs.writeFileSync(`${out}/isolation.json`, JSON.stringify({ ok: true, namespaces, login,
    ports: [boundary.sentinelPort, 9880, 3004], dummyPid: child.pid, privateProc: true,
    hostCredentialsHidden: true, externalNetwork: false }));
  if (process.argv.includes('--hold')) return await new Promise(() => setInterval(() => {}, 1000));
  if (process.argv[2] === 'accept') await import('./accept.mjs');
  await new Promise(resolve => setTimeout(resolve, 500)); // Let the outer owner census normal-exit descendants.
}

main().catch(() => {
  fs.writeFileSync(`${out}/failure.json`, JSON.stringify({ phase: 'isolation-or-acceptance', ok: false }));
  process.exit(1);
});
