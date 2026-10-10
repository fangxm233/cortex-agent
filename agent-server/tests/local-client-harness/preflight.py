#!/usr/bin/env python3
"""Isolation-only tests, including abrupt launcher-parent death. No product tgz."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import time

from mounts import CLEAN

ROOT = Path(__file__).resolve().parent


def wait_for(predicate, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise RuntimeError('Preflight timed out; STOP, no unsafe fallback')


def namespace_members(identity):
    members = []
    for path in Path('/proc').glob('[0-9]*'):
        try:
            if os.readlink(path / 'ns/pid') == identity:
                stat = (path / 'stat').read_text().rsplit(')', 1)[1].split()
                members.append({'pid': int(path.name), 'start': stat[19]})
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return members


def reap():
    try:
        while os.waitpid(-1, os.WNOHANG)[0]:
            pass
    except ChildProcessError:
        pass


def all_gone(members, namespace):
    reap()
    live = []
    for member in members:
        try:
            stat = Path(f"/proc/{member['pid']}/stat").read_text().rsplit(')', 1)[1].split()
            if stat[19] == member['start']:
                live.append(member['pid'])
        except (FileNotFoundError, ProcessLookupError):
            pass
    return not live and not namespace_members(namespace)


def launch(args, port, mode):
    cmd = [sys.executable, '-E', '-s', '-B', str(ROOT / 'launch.py'), 'probe',
           '--node-dir', str(args.node_dir), '--deps', str(args.deps),
           '--evidence', str(args.evidence), '--sentinel-port', str(port)]
    for root in args.dependency_root:
        cmd += ['--dependency-root', str(root)]
    if mode != 'normal':
        cmd.append('--hold')
    poison = dict(CLEAN, ANTHROPIC_API_KEY='dummy-must-not-cross',
                  HTTPS_PROXY='http://127.0.0.1:1', CORTEX_REPO='/host-not-allowed',
                  BASH_ENV='/host-not-allowed', NODE_OPTIONS='--invalid-host-option')
    child = subprocess.Popen(cmd, env=poison, stdout=subprocess.PIPE, text=True)
    if not select.select([child.stdout], [], [], 10)[0]:
        raise RuntimeError('Launcher did not identify its owned run')
    run = Path(json.loads(child.stdout.readline())['run'])
    return child, run


def checked_evidence(child, path):
    if path.exists():
        return json.loads(path.read_text())
    if child.poll() is not None:
        raise RuntimeError('Namespace/preflight failed; STOP; inspect private run logs')
    return None


def one_case(args, sentinel, mode):
    child, run = launch(args, sentinel.getsockname()[1], mode)
    try:
        info = wait_for(lambda: checked_evidence(child, run / 'ready.json'))
        proof = wait_for(lambda: checked_evidence(child, run / 'home/.harness/isolation.json'))
        members = namespace_members(info['namespaces']['pid'])
        if mode != 'normal':
            child.send_signal({'term': signal.SIGTERM, 'kill': signal.SIGKILL}[mode])
        code = child.wait(timeout=20)
        wait_for(lambda: all_gone(members, info['namespaces']['pid']), 10)
        assert code == {'normal': 0, 'term': 130, 'kill': -9}[mode]
        assert not select.select([sentinel], [], [], 0)[0], 'Host sentinel contacted'
        return {'mode': mode, 'run': str(run), 'exitCode': code, 'isolation': proof,
                'observedHostProcesses': members, 'noLingeringPids': True,
                'hostSentinelContacted': False}
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        child.stdout.close()


def sentinel_socket():
    sentinel = socket.socket()
    try:
        sentinel.bind(('127.0.0.1', 9880))
    except OSError:
        sentinel.bind(('127.0.0.1', 0))  # No connection to an occupied host gateway.
    sentinel.listen(8)
    return sentinel


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-dir', type=Path, required=True)
    parser.add_argument('--deps', type=Path, required=True)
    parser.add_argument('--dependency-root', type=Path, action='append', default=[])
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0  # Own-process subreaper only.
    with sentinel_socket() as sentinel:
        results = [one_case(args, sentinel, mode) for mode in ('normal', 'term', 'kill')]
    report = args.evidence / 'preflight.json'
    report.write_text(json.dumps({'ok': True, 'productRun': False, 'cases': results}, indent=2))
    print(json.dumps({'ok': True, 'cases': 3, 'report': str(report), 'productRun': False}))


if __name__ == '__main__':
    main()
