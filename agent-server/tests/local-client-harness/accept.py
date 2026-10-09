#!/usr/bin/env python3
"""Parent-only entry: explicitly run a supplied integrated tgz; never build/install."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

from mounts import CLEAN
from preflight import (ROOT, all_gone, checked_evidence, namespace_members,
                       sentinel_socket, wait_for)


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-dir', type=Path, required=True)
    parser.add_argument('--deps', type=Path, required=True)
    parser.add_argument('--dependency-root', type=Path, action='append', default=[])
    parser.add_argument('--tgz', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    return parser.parse_args()


def start(args, port):
    cmd = [sys.executable, '-E', '-s', '-B', str(ROOT / 'launch.py'), 'accept',
           '--node-dir', str(args.node_dir), '--deps', str(args.deps), '--tgz', str(args.tgz),
           '--evidence', str(args.evidence), '--sentinel-port', str(port)]
    for root in args.dependency_root:
        cmd += ['--dependency-root', str(root)]
    child = subprocess.Popen(cmd, env=CLEAN, stdout=subprocess.PIPE, text=True)
    run = Path(json.loads(child.stdout.readline())['run'])
    return child, run


def interrupt(signum, frame):
    raise KeyboardInterrupt


def run_product(args, sentinel):
    child, run = start(args, sentinel.getsockname()[1])
    info = None
    members = []
    try:
        info = wait_for(lambda: checked_evidence(child, run / 'ready.json'))
        wait_for(lambda: checked_evidence(child, run / 'home/.harness/isolation.json'))
        members = namespace_members(info['namespaces']['pid'])
        return child.wait(timeout=330), run
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=15)
        if info:
            wait_for(lambda: all_gone(members, info['namespaces']['pid']), 10)
        child.stdout.close()


def main():
    os.umask(0o077)
    args = options()
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    signal.signal(signal.SIGTERM, interrupt)
    with sentinel_socket() as sentinel:
        code, run = run_product(args, sentinel)
        import select
        contacted = bool(select.select([sentinel], [], [], 0)[0])
    summary = {'exitCode': code, 'hostSentinelContacted': contacted, 'noLingeringPids': True,
               'productRun': True, 'freshDependencyInstall': False, 'run': str(run)}
    (run / 'cleanup.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))
    return code or int(contacted)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
