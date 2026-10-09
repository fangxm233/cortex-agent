"""Empty root, exact tool/library inputs, private proc and synthetic login files."""
import os
from pathlib import Path
import re
import subprocess

CLEAN = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
HOME = '/home/tester'
NODE = '/inputs/node'
TOOLS = 'bash sh env hostname uname which sleep ps kill mkdir cat dirname readlink'.split()


def environment():
    return dict(CLEAN, HOME=HOME, USER='tester', LOGNAME='tester', SHELL='/bin/bash',
                PATH=f'{NODE}/bin:/usr/bin:/bin', CORTEX_HOME=f'{HOME}/.cortex',
                CORTEX_NPM_PREFIX=f'{HOME}/npm-prefix',
                npm_config_prefix=f'{HOME}/npm-prefix', npm_config_cache=f'{HOME}/npm-cache',
                npm_config_userconfig=f'{HOME}/.npmrc', npm_config_globalconfig='/etc/npmrc',
                CLAUDE_CONFIG_DIR=f'{HOME}/claude', XDG_CONFIG_HOME=f'{HOME}/.config',
                XDG_CACHE_HOME=f'{HOME}/.cache', XDG_DATA_HOME=f'{HOME}/.local/share',
                XDG_STATE_HOME=f'{HOME}/.local/state', XDG_RUNTIME_DIR=f'{HOME}/.run',
                XDG_CONFIG_DIRS='/etc/xdg', XDG_DATA_DIRS='/usr/share',
                CORTEX_UI_PORT='3004', WEBHOOK_PORT='3001', CORTEX_CLIENT_PORT='3002',
                CORTEX_TUI_PORT='3003')


def synthetic_etc(run):
    directory = run / 'etc'
    directory.mkdir()
    files = {'passwd': f'tester:x:{os.getuid()}:{os.getgid()}:Test:{HOME}:/bin/bash\n',
             'group': f'tester:x:{os.getgid()}:\n', 'hosts': '127.0.0.1 localhost\n',
             'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files\n',
             'resolv.conf': '', 'environment': '', 'npmrc': 'offline=true\n',
             'profile': f'export HOME={HOME}\nexport PATH={NODE}/bin:/usr/bin:/bin\n',
             'bash.bashrc': '', 'machine-id': '00000000000000000000000000000001\n'}
    for name, content in files.items():
        (directory / name).write_text(content)
    return directory


def library_paths(binaries, roots=()):
    """ldd only trusted supplied binaries; mount exact public libraries, not /usr/lib."""
    found = set()
    for binary in binaries:
        result = subprocess.run(['/usr/bin/ldd', str(binary)], env=CLEAN,
                                capture_output=True, text=True, timeout=10)
        found.update(re.findall(r'(?:=>\s+|^\s*)(/[^\s]+)\s+\(0x', result.stdout, re.M))
    found = {p for p in found if not any(Path(p).resolve().is_relative_to(r) for r in roots)}
    for path in found:
        if not Path(path).resolve().is_relative_to('/usr/lib'):
            raise ValueError('Library outside system library tree')
    return sorted(found)


def ro(source, target=None):
    return ['--ro-bind', str(source), str(target or source)]


def filesystem(run, node, roots, package):
    args = ['--dir', '/usr/bin', '--dir', '/usr/lib', '--dir', '/usr/lib64',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/etc', '--dir', '/home']
    binaries = [Path('/usr/bin') / tool for tool in TOOLS]
    natives = [p for root in roots for p in root.rglob('*.node')]
    for library in library_paths([*binaries, node / 'bin/node', *natives], roots):
        args += ro(Path(library).resolve(), library)
    for binary in binaries:
        args += ro(binary.resolve(), binary)
    args += ro(node, NODE) + ro(synthetic_etc(run), '/etc')
    for root in roots:
        args += ro(root)  # Preserve absolute symlink resolution without mounting ancestors.
    if package:
        args += ro(package, '/inputs/server')
    for script in Path(__file__).parent.glob('*.mjs'):
        args += ro(script, '/harness/' + script.name)
    args += ro(run / 'boundary.json', '/harness/boundary.json')
    args += ['--bind', str(run / 'home'), HOME, '--remount-ro', '/']
    return args
