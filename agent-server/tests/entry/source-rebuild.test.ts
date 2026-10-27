import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { runSourceRebuild, selectRebuildInstallPlan, type SourceRebuildOptions } from '../../src/entry/source-rebuild.js';
import { spawnRebuildCommand } from '../../src/entry/source-rebuild-build.js';
import { withServerNpmPrefix } from '../../src/core/utils.js';
import { planRebuildProgress } from '../../src/core/rebuild-progress.js';
import * as bundleInstaller from '../../src/entry/bundle-install.js';

vi.mock('../../src/entry/bundle-install.js', () => ({
  validateBundleStage: vi.fn(), planBundleInstall: vi.fn(),
  applyBundleInstall: vi.fn(), copyBundleSourceMaps: vi.fn(),
}));
const bundle = vi.mocked(bundleInstaller);
const roots: string[] = [];

function fixtureDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-rebuild-test-'));
  roots.push(root);
  const repoDir = path.join(root, 'repo');
  const installRoot = path.join(root, 'installed');
  fs.mkdirSync(repoDir);
  fs.mkdirSync(installRoot);
  fs.writeFileSync(path.join(installRoot, 'sentinel'), 'old');
  return { repoDir, installRoot };
}

function commandFixture() {
  const calls: { cmd: string; args: string[]; opts: { cwd: string; env?: NodeJS.ProcessEnv } }[] = [];
  let stage = '';
  const run: SourceRebuildOptions['run'] = vi.fn(async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === process.execPath) { stage = args[1]; assert.equal(fs.existsSync(stage), false); fs.mkdirSync(stage); }
    if (args[0] === 'pack') fs.writeFileSync(path.join(opts.cwd, 'cortex-agent-server-1.tgz'), 'tar');
    return 0;
  });
  return { run, calls, stage: () => stage };
}

function fixture() {
  const { repoDir, installRoot } = fixtureDirs();
  const commands = commandFixture();
  const events: string[] = [];
  let progress = planRebuildProgress({ reason: 'test', names: ['server', 'bundle', 'install', 'restart'], daemonPid: 1 });
  const options: SourceRebuildOptions = {
    dirs: { repoDir }, installRoot, bundle: true,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    update: patch => { progress = patch(progress); events.push(`progress:${progress.current}`); },
    abort: vi.fn(), deferInstall: vi.fn(() => { events.push('idle-gate'); return false; }),
    restart: vi.fn(async () => { events.push('restart'); assert.ok(fs.existsSync(commands.stage() || repoDir)); }),
    run: commands.run,
  };
  return { options, events, ...commands, progress: () => progress };
}

beforeEach(() => {
  vi.mocked(bundle.planBundleInstall).mockReturnValue({ blocked: null } as any);
  vi.mocked(bundle.applyBundleInstall).mockReturnValue(['dist', 'vendor']);
});
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.each([
  [true, null, 'bundle-fast'],
  [true, 'installed package is unbundled', 'bundle-full'],
  [true, 'optional dependency closure changed', 'bundle-full'],
  [false, null, 'source'],
  [false, 'installed bundle', 'source'],
] as const)('pure selector bundle=%s blocked=%s chooses %s', (enabled, blocked, expected) => {
  assert.equal(selectRebuildInstallPlan({ bundle: enabled, bundleBlocked: blocked }), expected);
});

test('bundles after lanes, validates before idle gate, fast installs then immediately restarts', async () => {
  const f = fixture();
  vi.mocked(bundle.validateBundleStage).mockImplementation(() => { f.events.push('validate'); });
  vi.mocked(bundle.applyBundleInstall).mockImplementation(() => { f.events.push('apply'); return ['dist']; });
  assert.equal(await runSourceRebuild(f.options), 'finished');
  assert.deepEqual(f.calls.map(c => c.args), [['run', 'build'], ['scripts/bundle.mjs', f.stage(), '--sourcemap']]);
  assert.deepEqual(f.events.filter(e => !e.startsWith('progress:')), ['validate', 'idle-gate', 'apply', 'restart']);
  assert.ok(f.events.indexOf('idle-gate') < f.events.indexOf('progress:install'));
  assert.equal(fs.existsSync(path.dirname(f.stage())), false);
  assert.equal(f.progress().steps.find(s => s.name === 'bundle')?.status, 'done');
  assert.equal(bundle.copyBundleSourceMaps.mock.calls.length, 0);
});

test.each(['command', 'validation'])('bundle %s failure leaves installed bytes and restart untouched', async failure => {
  const f = fixture();
  const run = vi.mocked(f.options.run).getMockImplementation()!;
  if (failure === 'command') vi.mocked(f.options.run).mockImplementation(async (...args) => {
    await run(...args);
    return args[0] === process.execPath ? 2 : 0;
  });
  else vi.mocked(bundle.validateBundleStage).mockImplementation(() => { throw new Error('invalid stage'); });
  await runSourceRebuild(f.options);
  assert.equal(fs.readFileSync(path.join(f.options.installRoot, 'sentinel'), 'utf8'), 'old');
  assert.equal(bundle.applyBundleInstall.mock.calls.length, 0);
  assert.equal(bundle.planBundleInstall.mock.calls.length, 0);
  assert.equal(vi.mocked(f.options.restart).mock.calls.length, 0);
  assert.equal(vi.mocked(f.options.deferInstall).mock.calls.length, 0);
  assert.equal(f.calls.some(c => c.args[0] === 'install'), false);
  assert.deepEqual(vi.mocked(f.options.abort).mock.calls, [['bundle', failure === 'command' ? 'exit 2' : 'invalid stage']]);
  assert.equal(fs.existsSync(path.dirname(f.stage())), false);
});

test('second idle gate discards the owned stage without touching the install or holding turns', async () => {
  const f = fixture();
  vi.mocked(f.options.deferInstall).mockReturnValue(true);
  assert.equal(await runSourceRebuild(f.options), 'deferred');
  assert.equal(bundle.planBundleInstall.mock.calls.length, 0);
  assert.equal(vi.mocked(f.options.restart).mock.calls.length, 0);
  assert.equal(f.events.includes('progress:install'), false);
  assert.equal(fs.existsSync(path.dirname(f.stage())), false);
});

test.each(['installed package is unbundled', 'optional dependency closure changed'])('full bundle install: %s', async blocked => {
  const f = fixture();
  vi.mocked(bundle.planBundleInstall).mockReturnValue({ blocked } as any);
  vi.mocked(bundle.copyBundleSourceMaps).mockImplementation((stage, root) => {
    assert.ok(fs.existsSync(stage));
    assert.equal(root, f.options.installRoot);
    f.events.push('maps');
  });
  await runSourceRebuild(f.options);
  const pack = f.calls.find(c => c.args[0] === 'pack')!;
  assert.deepEqual(pack.args, ['pack', '--ignore-scripts']);
  assert.equal(pack.opts.cwd, f.stage());
  const install = f.calls.find(c => c.args[0] === 'install')!;
  assert.deepEqual(install.args, withServerNpmPrefix(['install', '-g', path.join(f.stage(), 'cortex-agent-server-1.tgz')], f.options.installRoot));
  assert.equal(install.opts.env?.CORTEX_SKIP_POSTINSTALL_RESTART, '1');
  assert.equal(install.opts.env?.CORTEX_HOME, process.env.CORTEX_HOME);
  assert.equal(install.opts.env?.HOME, process.env.HOME);
  assert.ok(f.calls.filter(c => c !== install).every(c => c.opts.env === undefined));
  assert.deepEqual(f.events.filter(e => e === 'maps' || e === 'restart'), ['maps', 'restart']);
  assert.equal(fs.existsSync(path.dirname(f.stage())), false);
});

test('source rollback uses the existing planner and retains npm pack lifecycle semantics', async () => {
  const f = fixture();
  f.options.bundle = false;
  fs.writeFileSync(path.join(f.options.dirs.repoDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(f.options.installRoot, 'package.json'), '{"cortexBundle":true}');
  await runSourceRebuild(f.options);
  assert.deepEqual(f.calls.map(c => c.args[0]), ['run', '-c', 'pack', 'install']);
  assert.deepEqual(f.calls.find(c => c.args[0] === 'pack')?.args, ['pack']);
  assert.equal(f.calls.find(c => c.args[0] === 'pack')?.opts.cwd, f.options.dirs.repoDir);
  assert.equal(bundle.validateBundleStage.mock.calls.length, 0);
  assert.equal(vi.mocked(f.options.restart).mock.calls.length, 1);
  assert.equal(f.calls.at(-1)?.opts.env?.CORTEX_SKIP_POSTINSTALL_RESTART, '1');
});

test.each(['pack', 'install'])('bundle %s failure cleans stage, skips maps and never restarts', async step => {
  const f = fixture();
  bundle.planBundleInstall.mockReturnValue({ blocked: 'dependency closure changed' } as any);
  const run = vi.mocked(f.options.run).getMockImplementation()!;
  vi.mocked(f.options.run).mockImplementation(async (...args) => {
    await run(...args);
    return args[1][0] === step ? 2 : 0;
  });
  await runSourceRebuild(f.options);
  assert.deepEqual(vi.mocked(f.options.abort).mock.calls, [[step, 'exit 2']]);
  assert.equal(vi.mocked(f.options.restart).mock.calls.length, 0);
  assert.equal(bundle.copyBundleSourceMaps.mock.calls.length, 0);
  assert.equal(f.calls.some(c => c.cmd === 'bash'), false, 'no source fallback');
  assert.equal(fs.existsSync(path.dirname(f.stage())), false);
});

test('bundle fast-copy failure does not fall back to installing the original source', async () => {
  const f = fixture();
  bundle.applyBundleInstall.mockImplementation(() => { throw new Error('copy failed'); });
  await runSourceRebuild(f.options);
  assert.deepEqual(vi.mocked(f.options.abort).mock.calls, [['install', 'copy failed']]);
  assert.equal(vi.mocked(f.options.restart).mock.calls.length, 0);
  assert.deepEqual(f.calls.map(c => c.cmd), ['npm', process.execPath]);
  assert.equal(fs.existsSync(path.dirname(f.stage())), false);
});

test('map restoration failure warns but restarts the already replaced installation', async () => {
  const f = fixture();
  bundle.planBundleInstall.mockReturnValue({ blocked: 'unbundled install' } as any);
  bundle.copyBundleSourceMaps.mockImplementation(() => { throw new Error('map copy failed'); });
  await runSourceRebuild(f.options);
  assert.equal(vi.mocked(f.options.abort).mock.calls.length, 0);
  assert.equal(vi.mocked(f.options.restart).mock.calls.length, 1);
  assert.match(String(vi.mocked(f.options.log.warn).mock.calls), /map copy failed/);
  assert.equal(fs.existsSync(path.dirname(f.stage())), false);
});

test('source rollback still fast-syncs a matching unbundled install', async () => {
  const f = fixture();
  f.options.bundle = false;
  const original = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8'));
  const manifest = JSON.stringify({ files: original.files });
  fs.writeFileSync(path.join(f.options.dirs.repoDir, 'package.json'), manifest);
  fs.writeFileSync(path.join(f.options.installRoot, 'package.json'), manifest);
  fs.mkdirSync(path.join(f.options.dirs.repoDir, 'dist'));
  fs.writeFileSync(path.join(f.options.dirs.repoDir, 'dist/new.js'), 'new source');
  await runSourceRebuild(f.options);
  assert.deepEqual(f.calls.map(c => c.args), [['run', 'build']]);
  assert.equal(fs.readFileSync(path.join(f.options.installRoot, 'dist/new.js'), 'utf8'), 'new source');
  assert.equal(vi.mocked(f.options.restart).mock.calls.length, 1);
  assert.equal(bundle.planBundleInstall.mock.calls.length, 0);
});

test('workspace lanes stay concurrent and staging waits for all lanes', async () => {
  const f = fixture();
  f.options.dirs = { ...f.options.dirs, uiContractDir: '/fixture/ui-contract', webDir: '/fixture/web' };
  const run = vi.mocked(f.options.run).getMockImplementation()!;
  let release: () => void = () => {};
  const serverDone = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.options.run).mockImplementation(async (...args) => {
    const result = await run(...args);
    if (args[2].cwd === f.options.dirs.repoDir && args[1][0] === 'run') await serverDone;
    return result;
  });
  const pending = runSourceRebuild(f.options);
  assert.deepEqual(f.calls.map(c => c.args), [['run', 'build'], ['run', 'bundle'], ['run', 'depcruise']]);
  assert.equal(f.stage(), '');
  release();
  await pending;
  assert.deepEqual(f.calls.slice(3).map(c => c.args), [
    ['run', 'build'], ['run', 'typecheck'], ['scripts/bundle.mjs', f.stage(), '--sourcemap'],
  ]);
});

test('failed build lanes report every failure without staging or installing', async () => {
  const f = fixture();
  f.options.dirs = { ...f.options.dirs, webDir: '/fixture/web' };
  const run = vi.mocked(f.options.run).getMockImplementation()!;
  vi.mocked(f.options.run).mockImplementation(async (...args) => {
    await run(...args);
    return args[1][1] === 'depcruise' ? 0 : 2;
  });
  await runSourceRebuild(f.options);
  assert.deepEqual(vi.mocked(f.options.abort).mock.calls, [['server, web-bundle', 'exit 2, exit 2']]);
  assert.equal(f.stage(), '');
  assert.equal(vi.mocked(f.options.restart).mock.calls.length, 0);
  assert.equal(bundle.validateBundleStage.mock.calls.length, 0);
});

test('spawned build commands retain the isolated parent environment', async () => {
  const lines: string[] = [];
  const log = { info: (line: string) => lines.push(line), error: (line: string) => lines.push(line), warn: vi.fn() };
  const script = 'console.log(JSON.stringify({home:process.env.HOME,cortex:process.env.CORTEX_HOME}))';
  const result = await spawnRebuildCommand(process.execPath, ['-e', script], { cwd: os.tmpdir() }, log);
  assert.equal(result, 0);
  assert.ok(lines.some(line => line.includes(JSON.stringify({ home: process.env.HOME, cortex: process.env.CORTEX_HOME }))));
});
