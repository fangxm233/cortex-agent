"""Read-only inputs and safe thin-tgz extraction; no npm installation."""
import os
from pathlib import Path, PurePosixPath
import tarfile


def extract_package(tgz, destination):
    with tarfile.open(tgz, 'r:gz') as archive:
        members = archive.getmembers()
        for member in members:
            parts = PurePosixPath(member.name).parts
            safe = parts and parts[0] == 'package' and '..' not in parts
            if not safe or not (member.isfile() or member.isdir()):
                raise ValueError('Only regular files/directories under package/ are accepted')
        archive.extractall(destination, members=members)
    return destination / 'package'


def within(path, roots):
    return any(path.is_relative_to(root) for root in roots)


def audit_links(roots):
    """Follow no directory links; require every resolved target in explicit roots."""
    count = 0
    for root in roots:
        for directory, dirs, files in os.walk(root):
            for name in dirs + files:
                count += audit_link(Path(directory) / name, roots)
    return count


def audit_link(path, roots):
    if not path.is_symlink():
        return 0
    target = path.resolve(strict=True)
    if not within(target, roots):
        raise ValueError(f'External input symlink needs an explicit exact dependency root: {path}')
    return 1


def dependency_roots(primary, extras):
    root = primary.resolve(strict=True)
    if root.name != 'node_modules' or not root.is_dir():
        raise ValueError('--deps must be an existing node_modules directory')
    additional = [p.resolve(strict=True) for p in extras]
    for path in additional:
        if not (path / 'package.json').is_file():
            raise ValueError('Additional roots must be exact dependency packages, not ancestors')
    roots = [root, *additional]
    audit_links(roots)
    return roots
