// input:  synthetic strace lines and C8 policy roots
// output: parser, access-mode, path, socket, and fail-closed proofs
// pos:    Pure access-probe policy regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, it } from 'vitest';
import {
  classifyTraceLines,
  type AccessProbePolicy,
} from '../../../src/domain/agent-run/access-probe-policy.js';

let root = '';
let policy: AccessProbePolicy;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'access-policy-'));
  for (const dir of ['workspace', 'cortex', 'logs', 'install', 'host/.cortex']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  policy = {
    workspace: path.join(root, 'workspace'),
    cortexHome: path.join(root, 'cortex'),
    logsDir: path.join(root, 'logs'),
    installRoot: path.join(root, 'install'),
    hostHome: path.join(root, 'host'),
    hostCortexHome: path.join(root, 'host/.cortex'),
    nodeExecutable: process.execPath,
  };
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function trace(...calls: string[]) {
  return classifyTraceLines(calls, {
    policy,
    initialCwd: policy.workspace,
    pid: 321,
    traceFile: 'trace.321',
  });
}

it('allows workspace and trial state writes plus install reads', () => {
    const result = trace(
      `1.0 openat(AT_FDCWD<${policy.workspace}>, "result.txt", O_WRONLY|O_CREAT, 0666) = 3<${policy.workspace}/result.txt>`,
      `1.1 openat(AT_FDCWD<${policy.workspace}>, "${policy.cortexHome}/data/state.json", O_RDWR|O_CREAT, 0666) = 4`,
      `1.2 newfstatat(AT_FDCWD<${policy.workspace}>, "${policy.installRoot}/defaults/config.json", {st_mode=S_IFREG}, 0) = 0`,
      `1.3 openat(AT_FDCWD<${policy.workspace}>, "${policy.logsDir}/probe.log", O_WRONLY|O_CREAT, 0666) = 5`,
    );

    assert.equal(result.violations.length, 0);
    assert.equal(result.counts.fileCalls, 4);
  assert.equal(result.counts.allowed, 4);
});

it('denies a failed host Cortex access and names the offender', () => {
    const offender = path.join(policy.hostCortexHome, 'data/secret.json');
    const result = trace(
      `2.0 openat(AT_FDCWD<${policy.workspace}>, "${offender}", O_WRONLY|O_CREAT, 0666) = -1 EACCES (Permission denied)`,
    );

    assert.deepEqual(result.violations.map(({ syscall, path, access, reason }) => ({
      syscall, path, access, reason,
    })), [{
      syscall: 'openat',
      path: offender,
      access: 'write',
    reason: 'host_cortex_path',
  }]);
});

it('classifies both rename paths and rejects a write to the read-only install root', () => {
    const source = path.join(policy.workspace, 'source');
    const destination = path.join(policy.installRoot, 'destination');
    const result = trace(
      `3.0 renameat2(AT_FDCWD<${policy.workspace}>, "${source}", AT_FDCWD<${policy.workspace}>, "${destination}", RENAME_NOREPLACE) = 0`,
    );

    assert.equal(result.counts.fileCalls, 2);
  assert.deepEqual(result.violations.map(item => item.path), [destination]);
  assert.equal(result.violations[0].reason, 'read_only_root_write');
});

it('tracks chdir before resolving relative paths', () => {
    const nested = path.join(policy.workspace, 'nested');
    fs.mkdirSync(nested);
    const result = trace(
      `4.0 chdir("${nested}") = 0`,
      '4.1 openat(AT_FDCWD, "relative.txt", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)',
    );

  assert.equal(result.violations.length, 0);
  assert.equal(result.counts.allowed, 2);
});

it('allows only the pinned Node binary plus system path ancestors as runtime reads', () => {
  const nodeRoot = path.join(policy.hostHome, '.local/node-runtime');
  const nodeExecutable = path.join(nodeRoot, 'bin/node');
  fs.mkdirSync(path.dirname(nodeExecutable), { recursive: true });
  fs.writeFileSync(nodeExecutable, 'node');
  const result = classifyTraceLines([
    `4.2 execve("${nodeExecutable}", ["node"], 0x0) = 0`,
    `4.3 openat(AT_FDCWD<${policy.workspace}>, "${nodeRoot}/lib/node", O_RDONLY) = -1 ENOENT (No such file or directory)`,
    '4.4 readlink("/etc", 0x0, 1024) = -1 EINVAL (Invalid argument)',
    '4.5 readlink("/usr/share", 0x0, 1024) = -1 EINVAL (Invalid argument)',
    `4.6 inotify_add_watch(20, "${policy.cortexHome}/config", IN_MODIFY) = 1`,
  ], {
    policy: { ...policy, nodeExecutable }, initialCwd: policy.workspace,
    pid: 321, traceFile: 'trace.321',
  });

  assert.deepEqual(result.violations.map(item => item.path), [`${nodeRoot}/lib/node`]);
});

it('uses the resolved fd target so a removed workspace symlink cannot hide host access', () => {
  const apparent = path.join(policy.workspace, 'removed-link');
  const actual = path.join(policy.hostCortexHome, 'data/secret.json');
  const result = trace(
    `4.7 openat(AT_FDCWD<${policy.workspace}>, "${apparent}", O_RDONLY) = 3<${actual}>`,
  );

  assert.deepEqual(result.violations.map(({ path: offender, reason }) => ({
    path: offender, reason,
  })), [{ path: actual, reason: 'host_cortex_path' }]);
});

it('resolves a dangling workspace symlink before classifying a failed open', () => {
  const apparent = path.join(policy.workspace, 'dangling-link');
  const actual = path.join(policy.hostCortexHome, 'data/missing.json');
  fs.symlinkSync(actual, apparent);
  const result = trace(
    `4.71 openat(AT_FDCWD<${policy.workspace}>, "${apparent}", O_RDONLY) = -1 ENOENT (No such file or directory)`,
  );

  assert.deepEqual(result.violations.map(({ path: offender, reason }) => ({
    path: offender, reason,
  })), [{ path: apparent, reason: 'host_cortex_path' }]);
});

it('limits proc and Node runtime exceptions to traced pids and named paths', () => {
  const nodeRoot = path.join(policy.hostHome, '.local/node-runtime');
  const nodeExecutable = path.join(nodeRoot, 'bin/node');
  const escaped = path.join(policy.hostCortexHome, 'data/escaped.json');
  fs.mkdirSync(path.dirname(nodeExecutable), { recursive: true });
  fs.writeFileSync(nodeExecutable, 'node');
  fs.mkdirSync(path.dirname(escaped), { recursive: true });
  fs.writeFileSync(escaped, '{}');
  const result = classifyTraceLines([
    `4.8 openat(AT_FDCWD<${policy.workspace}>, "/proc/321/maps", O_RDONLY) = 3`,
    `4.9 openat(AT_FDCWD<${policy.workspace}>, "/proc/1/environ", O_RDONLY) = 4`,
    `4.10 openat(AT_FDCWD<${policy.workspace}>, "${nodeRoot}/share/secret", O_RDONLY) = 5`,
    `4.11 openat(AT_FDCWD<${policy.workspace}>, "/proc/self/root${escaped}", O_RDONLY) = 6<${escaped}>`,
    `4.12 openat(AT_FDCWD<${policy.workspace}>, "/proc/321/root${escaped}", O_RDONLY) = 7`,
  ], {
    policy: { ...policy, nodeExecutable, tracedPids: new Set([321]) },
    initialCwd: policy.workspace, pid: 321, traceFile: 'trace.321',
  });

  assert.deepEqual(result.violations.map(item => item.path), [
    '/proc/1/environ', path.join(nodeRoot, 'share/secret'),
    `/proc/self/root${escaped}`, `/proc/321/root${escaped}`,
  ]);
});

it('denies Internet sockets, bind, listen, and connect but permits Unix socketpair', () => {
  const result = trace(
    '5.0 socket(AF_INET, SOCK_STREAM|SOCK_CLOEXEC, IPPROTO_IP) = 20<TCP:[1]>',
    '5.1 socketpair(AF_UNIX, SOCK_STREAM, 0, [21<UNIX-STREAM:[2]>, 22<UNIX-STREAM:[3]>]) = 0',
    '5.2 bind(21<TCP:[1]>, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
    '5.3 listen(21<TCP:[127.0.0.1:43123]>, 511) = 0',
    '5.4 connect(22<TCP:[2]>, {sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ECONNREFUSED (Connection refused)',
  );

  assert.deepEqual(result.violations.map(({ syscall, path: offender, reason }) => ({
    syscall, path: offender, reason,
  })), [
    { syscall: 'socket', path: 'AF_INET', reason: 'network_socket_denied' },
    { syscall: 'socketpair', path: 'AF_UNIX', reason: 'unclassified_network_socket' },
    { syscall: 'bind', path: '127.0.0.1:0', reason: 'network_bind_denied' },
    { syscall: 'listen', path: '127.0.0.1:43123', reason: 'network_listen_denied' },
    { syscall: 'connect', path: '127.0.0.1:9', reason: 'network_connect_denied' },
  ]);
});

it('allows Unix metadata only on probe stdout/stderr and denies other descriptors', () => {
  const result = trace(
    '5.41 getsockname(1<UNIX-STREAM:[1->2]>, {sa_family=AF_UNIX}, [128 => 2]) = 0',
    '5.42 getsockopt(2<UNIX-STREAM:[3->4]>, SOL_SOCKET, SO_TYPE, [1], [4]) = 0',
    '5.43 getsockname(3<UNIX-STREAM:[5->6]>, {sa_family=AF_UNIX}, [128 => 2]) = 0',
  );

  assert.deepEqual(result.violations.map(({ syscall, reason }) => ({ syscall, reason })), [{
    syscall: 'getsockname', reason: 'unclassified_network_syscall',
  }]);
});

it('fails closed on socket operations outside the named Unix metadata exception', () => {
  const result = trace(
    '5.5 sendto(21<UNIX-STREAM:[2]>, "x", 1, 0, NULL, 0) = 1',
  );

  assert.deepEqual(result.violations.map(({ syscall, reason }) => ({ syscall, reason })), [{
    syscall: 'sendto', reason: 'unclassified_network_syscall',
  }]);
});

it('fails closed on an unknown or malformed traced syscall', () => {
    const result = trace(
      '6.0 mystery_path_call("somewhere") = 0',
      'this is not strace output',
    );

    assert.equal(result.violations.length, 2);
    assert.deepEqual(result.violations.map(item => item.reason), [
      'unclassified_syscall',
      'trace_parse_failed',
  ]);
  assert.ok(result.violations.every(item => item.path.length > 0));
});
