import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyBundleInstall, copyBundleSourceMaps, planBundleInstall, validateBundleStage,
} from '../../src/entry/bundle-install.js';

const FILES = [
  'dist/', 'defaults/', 'web/dist/', 'vendor/', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt',
  'scripts/bundle-prune-browser.mjs', 'scripts/postinstall-restart-trigger.mjs', '!**/*.map',
];
const RUNTIME = [
  'dist/entry/app.js', 'dist/entry/cortex-cli.js', 'dist/entry/cli.js', 'dist/entry/daemon.js',
  'dist/entry/production-app-bootstrap.js', 'dist/tui/index.js', 'dist/domain/mcp/bundled-server.js',
  'dist/agent-adapter/claude/remote-mcp-proxy.js', 'dist/core/pi-sdk.js', 'dist/domain/auth/cc-auth-cli.js',
  'vendor/aistatus/gateway-cli.js', 'vendor/pi/dist/utils/image-resize-worker.js',
  'vendor/pi/dist/utils/image-resize.js', 'vendor/pi/dist/core/extensions/loader.js',
  'vendor/pi-ai/oauth-load.js', 'vendor/pi-ai/bedrock.js', 'vendor/pi/dist/extensions/codemode/execute.js',
  'vendor/pi/dist/codemode-worker.js', 'vendor/quickjs.wasm', 'vendor/pi/package.json',
  'vendor/pi/README.md', 'vendor/pi/CHANGELOG.md', 'web/dist/index.html',
];
const ASSETS = [
  'defaults', 'dist/client-bundle', 'vendor/pi/docs', 'vendor/pi/examples', 'vendor/pi/schemas',
  'vendor/pi/dist/modes/interactive/theme', 'vendor/pi/dist/modes/interactive/assets',
  'vendor/pi/dist/core/export-html',
];
const OWNED = ['dist', 'defaults', 'web', 'vendor', 'scripts'];
const roots: string[] = [];

function put(root: string, name: string, text = 'new') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function manifest(overrides: object = {}) {
  return {
    name: '@cortex-agent/server', cortexBundle: true, version: '2', files: FILES,
    main: 'dist/entry/app.js', bin: { cortex: 'dist/entry/cortex-cli.js' },
    dependencies: { 'agent-browser': '1', '@silvia-odwyer/photon-node': '2' },
    optionalDependencies: { sharp: '3' }, ...overrides,
  };
}

function makeTrees(installed: object = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-install-'));
  roots.push(root);
  const stageDir = path.join(root, 'stage');
  const installRoot = path.join(root, 'installed');
  for (const name of [...RUNTIME, ...FILES.filter((f) => !f.endsWith('/') && !f.startsWith('!'))]) put(stageDir, name);
  for (const name of ASSETS) put(stageDir, `${name}/asset.txt`);
  put(stageDir, 'package.json', JSON.stringify(manifest()));
  put(stageDir, 'bundle-meta.json', 'audit only');
  for (const name of OWNED) put(installRoot, `${name}/stale.txt`, 'old');
  for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) put(installRoot, name, 'old');
  put(installRoot, 'package.json', JSON.stringify(manifest({ version: '1', ...installed })));
  for (const name of Object.keys(manifest().dependencies)) put(installRoot, `node_modules/${name}/package.json`, '{}');
  put(installRoot, 'node_modules/keep.txt', 'dependency bytes');
  return { stageDir, installRoot };
}

function snapshot(root: string) {
  return fs.readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
    const file = path.join(root, name);
    return [name, fs.statSync(file).isDirectory() ? null : fs.readFileSync(file).toString('base64')];
  });
}

function changeStage(stageDir: string, overrides: object) {
  put(stageDir, 'package.json', JSON.stringify(manifest(overrides)));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('matching bundle uses whole owned directories, metadata and local maps without touching dependencies', () => {
  const dirs = makeTrees();
  put(dirs.stageDir, 'dist/chunks/new-hash.js');
  put(dirs.stageDir, 'dist/chunks/new-hash.js.map', 'debug map');
  put(dirs.installRoot, 'dist/chunks/old-hash.js');
  put(dirs.installRoot, 'scripts/install-bundled-dependencies.mjs', 'obsolete installer');
  const dependencies = snapshot(path.join(dirs.installRoot, 'node_modules'));
  const plan = planBundleInstall(dirs);
  assert.equal(plan.blocked, null);
  const replaced = applyBundleInstall(plan);
  for (const name of OWNED) assert.ok(replaced.includes(name));
  for (const name of OWNED) assert.equal(fs.existsSync(path.join(dirs.installRoot, name, 'stale.txt')), false);
  assert.equal(fs.existsSync(path.join(dirs.installRoot, 'dist/chunks/old-hash.js')), false);
  assert.deepEqual(snapshot(path.join(dirs.installRoot, 'node_modules')), dependencies);
  for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'package.json']) {
    assert.ok(fs.statSync(path.join(dirs.installRoot, name)).isFile());
    assert.deepEqual(fs.readFileSync(path.join(dirs.installRoot, name)), fs.readFileSync(path.join(dirs.stageDir, name)));
  }
  assert.equal(fs.existsSync(path.join(dirs.installRoot, 'bundle-meta.json')), false);
  assert.equal(fs.existsSync(path.join(dirs.installRoot, 'scripts/install-bundled-dependencies.mjs')), false);
  assert.equal(fs.readFileSync(path.join(dirs.installRoot, 'dist/chunks/new-hash.js.map'), 'utf8'), 'debug map');
});

test('dependency and allowlist ordering are irrelevant; optional dependencies need not be installed', () => {
  const dirs = makeTrees({ dependencies: { '@silvia-odwyer/photon-node': '2', 'agent-browser': '1' } });
  changeStage(dirs.stageDir, { files: [...FILES].reverse() });
  assert.equal(planBundleInstall(dirs).blocked, null);
});

test.each([
  { dependencies: { 'agent-browser': 'changed' } }, { optionalDependencies: { sharp: 'changed' } },
  { peerDependencies: { peer: '1' } }, { bundleDependencies: ['other'] },
  { cortexBundle: false }, { name: 'other-package' },
])('incompatible installed manifest blocks full-directory sync: %j', (installed) => {
  const dirs = makeTrees(installed);
  const before = snapshot(dirs.installRoot);
  const plan = planBundleInstall(dirs);
  assert.ok(plan.blocked);
  assert.throws(() => applyBundleInstall(plan), /blocked/);
  assert.deepEqual(snapshot(dirs.installRoot), before);
});

test('closure arrays and optional dependency keys are normalized', () => {
  const dirs = makeTrees({ bundleDependencies: ['b', 'a'], optionalDependencies: { b: '2', a: '1' } });
  changeStage(dirs.stageDir, { bundleDependencies: ['a', 'b'], optionalDependencies: { a: '1', b: '2' } });
  assert.equal(planBundleInstall(dirs).blocked, null);
});

test('missing mandatory externals block, while hoisted externals are reachable', () => {
  const dirs = makeTrees();
  const modules = path.join(dirs.installRoot, 'node_modules');
  fs.renameSync(modules, path.join(path.dirname(dirs.installRoot), 'elsewhere'));
  assert.match(planBundleInstall(dirs).blocked ?? '', /dependency missing/);
  fs.renameSync(path.join(path.dirname(dirs.installRoot), 'elsewhere'), path.join(path.dirname(dirs.installRoot), 'node_modules'));
  assert.equal(planBundleInstall(dirs).blocked, null);
});

test.each(['package.json', 'dist/entry/daemon.js', 'web/dist/index.html', 'vendor/quickjs.wasm',
  'scripts/bundle-prune-browser.mjs', 'LICENSE', 'defaults'])('missing required stage entry throws before mutation: %s', (entry) => {
  const dirs = makeTrees();
  const plan = planBundleInstall(dirs);
  const before = snapshot(dirs.installRoot);
  fs.rmSync(path.join(dirs.stageDir, entry), { recursive: true });
  assert.throws(() => validateBundleStage(dirs.stageDir));
  assert.throws(() => planBundleInstall(dirs));
  assert.throws(() => applyBundleInstall(plan));
  assert.deepEqual(snapshot(dirs.installRoot), before);
});

test.each([
  { cortexBundle: false }, { name: 'wrong' }, { files: FILES.filter((f) => f !== '!**/*.map') },
  { files: [...FILES, 'unknown/'] }, { main: '../outside.js' }, { bin: { cortex: 'missing.js' } },
])('invalid stage manifest fails closed: %j', (overrides) => {
  const dirs = makeTrees();
  changeStage(dirs.stageDir, overrides);
  assert.throws(() => planBundleInstall(dirs));
});

test('missing stage throws even when the target needs a full npm install', () => {
  const dirs = makeTrees({ cortexBundle: false });
  assert.throws(() => planBundleInstall({ ...dirs, stageDir: path.join(dirs.stageDir, 'absent') }));
});

test('directory in place of required metadata is not treated as a file', () => {
  const dirs = makeTrees();
  fs.rmSync(path.join(dirs.stageDir, 'LICENSE'));
  fs.mkdirSync(path.join(dirs.stageDir, 'LICENSE'));
  assert.throws(() => validateBundleStage(dirs.stageDir));
});

test('incompatible installed entry types block instead of overlaying', () => {
  const dirs = makeTrees();
  fs.rmSync(path.join(dirs.installRoot, 'scripts'), { recursive: true });
  put(dirs.installRoot, 'scripts');
  assert.match(planBundleInstall(dirs).blocked ?? '', /layout/);
});

test('identical, nested, and symlink-aliased roots are rejected, never offered to npm', () => {
  const dirs = makeTrees();
  const alias = path.join(path.dirname(dirs.stageDir), 'alias');
  fs.symlinkSync(dirs.stageDir, alias, 'dir');
  for (const installRoot of [dirs.stageDir, alias, path.join(alias, 'nested'), path.dirname(dirs.stageDir)]) {
    assert.throws(() => planBundleInstall({ stageDir: dirs.stageDir, installRoot }), /overlap|separate/);
  }
});

test('dangling symlink ancestors cannot disguise an install root inside the stage', () => {
  const dirs = makeTrees();
  const alias = path.join(path.dirname(dirs.stageDir), 'dangling');
  fs.symlinkSync(path.join(dirs.stageDir, 'not-created'), alias, 'dir');
  assert.throws(() => planBundleInstall({ ...dirs, installRoot: path.join(alias, 'nested') }), /overlap|separate/);
});

test('stage symlinks into installed content are rejected before any replacement', () => {
  const dirs = makeTrees();
  fs.symlinkSync(path.join(dirs.installRoot, 'defaults'), path.join(dirs.stageDir, 'defaults/linked'), 'dir');
  assert.throws(() => planBundleInstall(dirs), /symlink/);
});

test('a late pre-copy failure leaves every installed entry unchanged', () => {
  const dirs = makeTrees();
  const plan = planBundleInstall(dirs);
  const before = snapshot(dirs.installRoot);
  const copy = fs.cpSync.bind(fs);
  vi.spyOn(fs, 'cpSync').mockImplementation((source, destination, options) => {
    if (String(source).endsWith('THIRD_PARTY_NOTICES.txt')) throw new Error('staged copy failure');
    return copy(source, destination, options);
  });
  assert.throws(() => applyBundleInstall(plan), /staged copy failure/);
  assert.deepEqual(snapshot(dirs.installRoot), before);
  assert.deepEqual(fs.readdirSync(path.dirname(dirs.installRoot)).sort(), ['installed', 'stage']);
});

test('a failed rename restores earlier replacements and the current entry', () => {
  const dirs = makeTrees();
  const before = snapshot(dirs.installRoot);
  const rename = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (String(source).includes('/new/scripts')) throw new Error('rename failure');
    return rename(source, destination);
  });
  assert.throws(() => applyBundleInstall(planBundleInstall(dirs)), /rename failure/);
  assert.deepEqual(snapshot(dirs.installRoot), before);
});

test('map restoration copies only maps across owned directories after npm installation', () => {
  const dirs = makeTrees();
  for (const name of ['dist/app.js.map', 'web/dist/assets/ui.js.map', 'vendor/pi/code.js.map']) put(dirs.stageDir, name, 'map');
  put(dirs.stageDir, 'node_modules/ignored.js.map', 'not owned');
  const before = snapshot(dirs.installRoot);
  copyBundleSourceMaps(dirs.stageDir, dirs.installRoot);
  for (const name of ['dist/app.js.map', 'web/dist/assets/ui.js.map', 'vendor/pi/code.js.map']) {
    assert.equal(fs.readFileSync(path.join(dirs.installRoot, name), 'utf8'), 'map');
  }
  assert.equal(fs.existsSync(path.join(dirs.installRoot, 'node_modules/ignored.js.map')), false);
  assert.deepEqual(snapshot(dirs.installRoot).filter(([name]) => before.some(([old]) => old === name)), before);
});

test('a valid release stage without maps makes map restoration a no-op', () => {
  const dirs = makeTrees();
  const before = snapshot(dirs.installRoot);
  validateBundleStage(dirs.stageDir);
  copyBundleSourceMaps(dirs.stageDir, dirs.installRoot);
  assert.deepEqual(snapshot(dirs.installRoot), before);
});

test('failure reading a later map leaves the installed tree unchanged', () => {
  const dirs = makeTrees();
  put(dirs.stageDir, 'dist/first.js.map');
  put(dirs.stageDir, 'vendor/last.js.map');
  const before = snapshot(dirs.installRoot);
  const read = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (String(file).endsWith('last.js.map')) throw new Error('map read failed');
    return read(file, options);
  });
  assert.throws(() => copyBundleSourceMaps(dirs.stageDir, dirs.installRoot), /map read failed/);
  assert.deepEqual(snapshot(dirs.installRoot), before);
});

test('map restoration refuses symlink destinations and source/install aliases', () => {
  const dirs = makeTrees();
  put(dirs.stageDir, 'dist/maps/code.js.map');
  fs.symlinkSync(dirs.stageDir, path.join(dirs.installRoot, 'dist/maps'), 'dir');
  assert.throws(() => copyBundleSourceMaps(dirs.stageDir, dirs.installRoot), /symlink|separate|overlap/);
  assert.throws(() => copyBundleSourceMaps(dirs.stageDir, dirs.stageDir), /separate|overlap/);
});
