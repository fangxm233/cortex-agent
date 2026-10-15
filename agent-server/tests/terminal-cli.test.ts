import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ownBinDirs, withDirsOnPath } from '../src/domain/system/own-bin-path.js';
import { profileTargets, posixRegistrar, removeBlock, renderBlock, upsertBlock } from '../src/domain/system/terminal-cli/posix-profiles.js';
import { addUserPathEntry, removeUserPathEntry, windowsRegistrar } from '../src/domain/system/terminal-cli/windows-user-path.js';
import { refreshShims, renderShims, shimDir } from '../src/domain/system/terminal-cli/shims.js';
import {
  installTerminalCli, removeTerminalCli, syncTerminalCli, terminalCliStatus, type TerminalCliContext,
} from '../src/domain/system/terminal-cli/index.js';
import { isManagedRuntimeInstall, readTerminalCliState } from '../src/domain/system/terminal-cli/state.js';
import { runPathCli } from '../src/entry/path-cli.js';

describe('own bin dirs on PATH', () => {
  it('adds the node dir and the npm prefix bin of a global install', () => {
    const root = '/u/.cortex/runtime/prefix/lib/node_modules/@cortex-agent/server';
    expect(ownBinDirs('/u/.cortex/runtime/node-v24/bin/node', root, 'linux'))
      .toEqual(['/u/.cortex/runtime/node-v24/bin', '/u/.cortex/runtime/prefix/bin']);
  });

  it('uses the flat prefix on Windows and only the node dir for a repo checkout', () => {
    const root = 'C:\\u\\.cortex\\runtime\\prefix\\node_modules\\@cortex-agent\\server';
    expect(ownBinDirs('C:\\n\\node.exe', root, 'win32')).toEqual(['C:\\n', 'C:\\u\\.cortex\\runtime\\prefix']);
    expect(ownBinDirs('/n/bin/node', '/src/Cortex/agent-server', 'linux')).toEqual(['/n/bin']);
  });

  it('prepends only missing dirs and keeps existing order', () => {
    expect(withDirsOnPath('/a:/n/bin/:/b', ['/n/bin', '/p/bin'], 'linux')).toBe('/p/bin:/a:/n/bin/:/b');
    expect(withDirsOnPath('C:\\N;D:\\x', ['c:\\n\\'], 'win32')).toBe('C:\\N;D:\\x');
  });
});

describe('shell profile block', () => {
  const block = renderBlock('/h/.cortex/runtime/bin');

  it('round-trips appended, prepended and new files byte for byte', () => {
    for (const original of ['export A=1\n', 'no newline', '']) {
      for (const position of ['top', 'bottom'] as const) {
        const added = upsertBlock(original, block, position);
        expect(added).toContain(block);
        expect(upsertBlock(added, block, position)).toBe(added);
        if (original.endsWith('\n') || original === '' || position === 'top') expect(removeBlock(added)).toBe(original);
      }
    }
  });

  it('replaces an older block in place', () => {
    const old = upsertBlock('x\n', renderBlock('/old/bin'), 'bottom');
    expect(upsertBlock(old, block, 'bottom')).toBe(upsertBlock('x\n', block, 'bottom'));
  });

  it('picks rustup-style targets', () => {
    const exists = (f: string) => f.endsWith('.bashrc');
    const targets = profileTargets({ home: '/h', platform: 'linux', exists, hasZsh: false });
    expect(targets).toEqual([{ file: '/h/.profile', position: 'bottom' }, { file: '/h/.bashrc', position: 'top' }]);
    const mac = profileTargets({ home: '/h', platform: 'darwin', zdotdir: '/z', exists: () => false, hasZsh: false });
    expect(mac.map((t) => t.file)).toEqual(['/h/.profile', '/z/.zshenv']);
  });
});

describe('Windows user Path', () => {
  it('prepends once and removes without touching other bytes', () => {
    const raw = '%USERPROFILE%\\bin;C:\\tools;';
    const added = addUserPathEntry(raw, 'C:\\h\\.cortex\\runtime\\bin');
    expect(added).toBe('C:\\h\\.cortex\\runtime\\bin;%USERPROFILE%\\bin;C:\\tools;');
    expect(addUserPathEntry(added, 'c:\\H\\.cortex\\runtime\\bin\\')).toBe(added);
    expect(removeUserPathEntry(added, 'C:\\h\\.cortex\\runtime\\bin')).toBe(raw);
    expect(addUserPathEntry(null, 'C:\\d')).toBe('C:\\d');
    expect(removeUserPathEntry('C:\\d', 'C:\\d')).toBe('');
  });

  it('plans through injected registry IO', () => {
    const writes: Array<string | null> = [];
    const registrar = windowsRegistrar({ read: () => 'C:\\a', write: (value) => { writes.push(value); } });
    registrar.apply(registrar.plan('C:\\d', 'add'));
    expect(writes).toEqual(['C:\\d;C:\\a']);
  });

  it('renders cmd and Git Bash launchers', () => {
    const shims = renderShims({ node: 'C:\\rt\\node\\node.exe', home: 'C:\\h\\.cortex', bins: [{ name: 'cortex', entry: 'C:\\p\\cli.js' }] }, 'win32');
    expect(shims.map((s) => s.file)).toEqual(['cortex.cmd', 'cortex']);
    expect(shims[0].content).toContain('"C:\\rt\\node\\node.exe" "C:\\p\\cli.js" %*\r\n');
    expect(shims[1].content).toContain("PATH='/c/rt/node':\"$PATH\"");
    expect(shims[1].content).toContain("exec 'C:/rt/node/node.exe' 'C:/p/cli.js' \"$@\"");
  });
});

describe('cortex path install / remove (POSIX, real shell)', () => {
  let tmp: string;
  let ctx: TerminalCliContext;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-path-'));
    const installRoot = path.join(tmp, 'pkg');
    fs.mkdirSync(path.join(installRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ bin: { cortex: 'dist/cli.js' } }));
    fs.writeFileSync(path.join(installRoot, 'dist/cli.js'),
      'console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.CORTEX_HOME, node: process.execPath }))\n');
    fs.mkdirSync(path.join(tmp, 'home'));
    fs.writeFileSync(path.join(tmp, 'home/.bashrc'), 'case $- in *i*) ;; *) return;; esac\nalias ll=ls\n');
    const registrar = posixRegistrar({ home: path.join(tmp, 'home'), platform: 'linux', exists: fs.existsSync, hasZsh: false });
    ctx = { home: path.join(tmp, 'cortex-home'), node: process.execPath, installRoot, platform: 'linux', pathEnv: '/usr/bin:/bin', registrar };
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const shell = (file: string) => execFileSync('/bin/sh', ['-c', `. "${file}" >/dev/null 2>&1; cortex a 'b c'`], {
    env: { PATH: '/usr/bin:/bin', HOME: path.join(tmp, 'home') }, encoding: 'utf8',
  });

  it('makes cortex runnable without node on PATH, then restores every file', () => {
    const bashrcBefore = fs.readFileSync(path.join(tmp, 'home/.bashrc'), 'utf8');
    const dry = installTerminalCli(ctx, true);
    expect(dry.written).toEqual(['cortex']);
    expect(fs.existsSync(shimDir(ctx.home))).toBe(false);

    const report = installTerminalCli(ctx, false);
    expect(report.path_targets.every((t) => t.changed)).toBe(true);
    for (const profile of ['.profile', '.bashrc']) {
      const out = JSON.parse(shell(path.join(tmp, 'home', profile)));
      expect(out).toEqual({ args: ['a', 'b c'], home: ctx.home, node: process.execPath });
    }
    expect(installTerminalCli(ctx, false).written).toEqual([]);
    expect(terminalCliStatus(ctx)).toMatchObject({ installed: true, stale: [], on_current_path: false });

    removeTerminalCli(ctx, false);
    expect(fs.readFileSync(path.join(tmp, 'home/.bashrc'), 'utf8')).toBe(bashrcBefore);
    expect(fs.readFileSync(path.join(tmp, 'home/.profile'), 'utf8')).toBe('');
    expect(fs.existsSync(shimDir(ctx.home))).toBe(false);
  });

  it('refresh rewrites installed launchers for a new node and skips homes without them', () => {
    const render = (node: string) => renderShims({ node, home: ctx.home, bins: [{ name: 'cortex', entry: '/e.js' }] }, 'linux');
    expect(refreshShims(shimDir(ctx.home), render('/old/node'))).toEqual([]);
    installTerminalCli(ctx, false);
    expect(refreshShims(shimDir(ctx.home), render('/new/node'))).toEqual(['cortex']);
    expect(fs.readFileSync(path.join(shimDir(ctx.home), 'cortex'), 'utf8')).toContain("exec '/new/node' '/e.js'");
  });

  it('server start installs once for a desktop-runtime install and honors remove', () => {
    const managed = path.join(ctx.home, 'runtime/prefix/lib/node_modules/@cortex-agent/server');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.cpSync(ctx.installRoot, managed, { recursive: true });
    const server = { ...ctx, installRoot: managed };
    expect(syncTerminalCli(server)).toEqual({ action: 'installed', files: ['cortex'] });
    expect(readTerminalCliState(ctx.home)).toBe('installed');
    expect(JSON.parse(shell(path.join(tmp, 'home/.profile'))).args).toEqual(['a', 'b c']);
    expect(syncTerminalCli(server)).toEqual({ action: 'refreshed', files: [] });
    removeTerminalCli(server, false);
    expect(syncTerminalCli(server)).toEqual({ action: 'skipped', files: [] });
    expect(fs.existsSync(shimDir(ctx.home))).toBe(false);
  });

  it('server start leaves other installs alone and retries an interrupted install', () => {
    expect(syncTerminalCli(ctx)).toEqual({ action: 'refreshed', files: [] });
    expect(fs.existsSync(path.join(tmp, 'home/.profile'))).toBe(false);
    const managed = path.join(ctx.home, 'runtime/prefix/lib/node_modules/@cortex-agent/server');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.cpSync(ctx.installRoot, managed, { recursive: true });
    const failing = { ...ctx, installRoot: managed, registrar: { ...ctx.registrar, apply: () => { throw new Error('EACCES'); } } };
    expect(() => syncTerminalCli(failing)).toThrow('EACCES');
    expect(syncTerminalCli({ ...ctx, installRoot: managed }).action).toBe('installed');
  });

  it('recognizes the desktop runtime prefix on each platform', () => {
    expect(isManagedRuntimeInstall('/h/.cortex', '/h/.cortex/runtime/prefix/lib/node_modules/@cortex-agent/server', 'linux')).toBe(true);
    expect(isManagedRuntimeInstall('/h/.cortex', '/h/.npm-global/lib/node_modules/@cortex-agent/server', 'linux')).toBe(false);
    expect(isManagedRuntimeInstall('C:\\Users\\X\\.cortex',
      'c:\\users\\x\\.cortex\\runtime\\prefix\\node_modules\\@cortex-agent\\server', 'win32')).toBe(true);
  });

  it('CLI rejects unknown subcommands with the valid list', () => {
    const result = runPathCli(['add'], () => ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('install');
    expect(runPathCli(['status', '--json'], () => ctx).stdout).toContain('"installed": false');
  });
});
