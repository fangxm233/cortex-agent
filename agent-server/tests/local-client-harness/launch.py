#!/usr/bin/env python3
"""Opt-in namespace owner. No host fallback, no shared state, no package installation."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import time
import uuid

from inputs import audit_links, dependency_roots, extract_package
from mounts import CLEAN, environment, filesystem

NAMESPACES = ('user', 'pid', 'net', 'mnt', 'ipc', 'uts')


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['probe', 'accept'])
    parser.add_argument('--node-dir', type=Path, required=True)
    parser.add_argument('--deps', type=Path, required=True)
    parser.add_argument('--dependency-root', type=Path, action='append', default=[])
    parser.add_argument('--tgz', type=Path)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--sentinel-port', type=int, required=True)
    parser.add_argument('--hold', action='store_true', help='Probe cancellation only')
    args = parser.parse_args()
    if (args.mode == 'accept') != bool(args.tgz):
        parser.error('accept requires --tgz; probe must not receive a product artifact')
    if args.hold and args.mode != 'probe':
        parser.error('--hold is isolation-only')
    return args


def namespaces(pid='self'):
    return {key: os.readlink(f'/proc/{pid}/ns/{key}') for key in NAMESPACES}


def make_run(args):
    args.evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
    run = args.evidence.resolve() / (time.strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8])
    run.mkdir(mode=0o700)
    (run / 'home/.harness').mkdir(parents=True, mode=0o700)
    (run / 'home/.run').mkdir(mode=0o700)
    (run / 'home/.npmrc').write_text('offline=true\n')
    boundary = {'hostNamespaces': namespaces(), 'hostHome': str(Path.home()),
                'hostPid': os.getpid(), 'sentinelPort': args.sentinel_port,
                'dependencyRoots': [str(p.resolve()) for p in [args.deps, *args.dependency_root]]}
    (run / 'boundary.json').write_text(json.dumps(boundary))
    print(json.dumps({'run': str(run)}), flush=True)
    return run


def prepare_inputs(args, run):
    node = args.node_dir.resolve(strict=True)
    if not (node / 'bin/node').is_file() or not (node / 'lib/node_modules/npm').is_dir():
        raise ValueError('Full existing Node/npm runtime required')
    audit_links([node])
    roots = dependency_roots(args.deps, args.dependency_root)
    package = None
    digest = hashlib.sha256(args.tgz.read_bytes()).hexdigest() if args.tgz else None
    if args.tgz:
        package = extract_package(args.tgz, run / 'extracted')
        (package / 'node_modules').symlink_to(roots[0])
    inputs = {'nodeRoot': str(node), 'dependencyRoots': [str(p) for p in roots],
              'auditedDependencySymlinks': audit_links(roots), 'tgzSha256': digest}
    (run / 'inputs.json').write_text(json.dumps(inputs, indent=2))
    return node, roots, package


def command(args, run, info_fd):
    node, roots, package = prepare_inputs(args, run)
    cmd = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net',
           '--unshare-ipc', '--unshare-uts', '--hostname', 'local-client-test',
           '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
           '--info-fd', str(info_fd), '--clearenv']
    cmd += filesystem(run, node, roots, package)
    for key, value in environment().items():
        cmd += ['--setenv', key, value]
    cmd += ['--chdir', '/home/tester', '--', '/inputs/node/bin/node',
            '/harness/probe.mjs', args.mode]
    return cmd + (['--hold'] if args.hold else [])


def wait_info(fd, child):
    data = b''
    deadline = time.monotonic() + 20
    while child.poll() is None and time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.1)[0]:
            continue
        data += os.read(fd, 4096)
        try:
            return json.loads(data)['child-pid']
        except (ValueError, KeyError):
            pass
    raise RuntimeError('Namespace setup failed; STOP (private bwrap.log)')


def stop(child):
    if child.poll() is not None:
        return
    child.terminate()  # Only the Popen-owned bwrap; PID namespace teardown kills descendants.
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)


def interrupt(signum, frame):
    raise KeyboardInterrupt


def execute(args, run):
    read_fd, write_fd = os.pipe()
    cmd = command(args, run, write_fd)
    with (run / 'bwrap.log').open('w') as log:
        child = subprocess.Popen(cmd, env=CLEAN, pass_fds=(write_fd,),
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        os.close(write_fd)
        try:
            pid = wait_info(read_fd, child)
            info = {'bwrapPid': child.pid, 'namespaceHostPid': pid, 'namespaces': namespaces(pid)}
            (run / 'ready.json').write_text(json.dumps(info))
            code = child.wait(timeout=300)
        finally:
            stop(child)
            os.close(read_fd)
    return code


def main():
    os.umask(0o077)
    parent = os.getppid()
    assert ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0) == 0
    if os.getppid() != parent:
        return 130
    args = options()
    run = make_run(args)
    signal.signal(signal.SIGTERM, interrupt)
    code = execute(args, run)
    inputs = json.loads((run / 'inputs.json').read_text())
    summary = {'mode': args.mode, 'exitCode': code, 'tgzSha256': inputs['tgzSha256'],
               'freshDependencyInstall': False}
    (run / 'launcher-result.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)
    return code


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        # Do not render exception data from product output or private files.
        print('Harness failed closed; inspect private run evidence locally.', flush=True)
        raise SystemExit(1)
