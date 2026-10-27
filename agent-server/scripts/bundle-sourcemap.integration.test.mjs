import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fixture, put, run } from './bundle-sourcemap-fixture.mjs';

function files(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile()).map(item => path.join(item.parentPath, item.name)).sort();
}
function snapshot(root) {
  return files(root).map(file => [path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
}
function stageFixture(context, local) {
  const stage = path.join(context.cwd, local ? 'local' : 'release');
  const result = run(process.execPath, ['scripts/bundle.mjs', stage, ...(local ? ['--sourcemap'] : [])], context.root);
  assert.equal(result.status, 0, result.stderr);
  return stage;
}
function frame(result, file, line, column) {
  assert.notEqual(result.status, 0);
  assert(result.stderr.includes(`${file}:${line}:${column}`), result.stderr);
  assert.doesNotMatch(result.stderr, /never\.ts/);
}
function errorColumn(root, file, line) {
  return fs.readFileSync(path.join(root, file), 'utf8').split('\n')[line - 1].indexOf('new Error') + 1;
}
function addUpstreamMaps(context) {
  const original = fs.readFileSync(path.join(context.root, 'dist/core/shared.js'), 'utf8');
  const upstream = JSON.stringify({ version: 3, sources: ['never.ts'], sourcesContent: ['throw Error();'],
    names: [], mappings: 'AAAA;AAAA;AAAA;AAAA' });
  put(context.root, 'dist/core/shared.js.map', upstream);
  put(context.root, 'dist/core/shared.js', original + 'export { mjsFail } from "./upstream.mjs";\n'
    + 'export { cjsFail } from "./upstream.cjs";\n//# sourceMappingURL=shared.js.map\n');
  put(context.root, 'dist/core/upstream.mjs', 'export function mjsFail() {\n  throw new Error("mjs fixture");\n}\n'
    + '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(upstream).toString('base64') + '\n');
  put(context.root, 'dist/core/upstream.cjs', 'exports.cjsFail = function () {\n  throw new Error("cjs fixture");\n};\n'
    + '/*# sourceMappingURL=shared.js.map */\n');
  const app = fs.readFileSync(path.join(context.root, 'dist/entry/app.js'), 'utf8')
    .replace('{ sharedFail }', '{ sharedFail, mjsFail, cjsFail }').replace('const actions = {', 'const actions = { mjs: mjsFail, cjs: cjsFail,');
  put(context.root, 'dist/entry/app.js', app + '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(upstream).toString('base64') + '\n');
}

function assertMaps(stage) {
  const bundled = files(stage).filter(file => file.endsWith('.js') && /\/(dist|vendor)\//.test(file));
  const linked = bundled.filter(file => fs.readFileSync(file, 'utf8').includes('sourceMappingURL='));
  assert(linked.some(file => file.includes('/dist/chunks/')));
  for (const file of linked) {
    const map = JSON.parse(fs.readFileSync(file + '.map', 'utf8'));
    assert.equal(map.version, 3);
    assert(map.sources.every(source => /^file:.*\.[cm]?js$/.test(source)), file);
    assert.equal(map.sources.length, map.sourcesContent.length);
    assert(fs.readFileSync(file, 'utf8').includes(`sourceMappingURL=${path.basename(file)}.map`));
  }
  assert.match(fs.readFileSync(path.join(stage, 'dist/entry/app.js'), 'utf8'), /^#!\/usr\/bin\/env node\nimport \{ createRequire/);
}

function assertPack(stage) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  assert.equal(manifest.cortexBundle, true);
  assert(manifest.files.includes('!**/*.map'));
  const before = snapshot(stage);
  const result = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', path.dirname(stage)], stage);
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  assert(pack.files.some(file => file.path === 'dist/entry/app.js'));
  assert(pack.files.some(file => file.path.startsWith('vendor/')));
  assert(pack.files.every(file => !file.path.endsWith('.map')));
  assert.deepEqual(snapshot(stage), before, 'npm pack must retain local stage maps');
}

async function checkFrames(t, context, stage) {
  const cases = [
    ['entry', context.root, 'dist/entry/app.js', 6],
    ['shared', context.root, 'dist/core/shared.js', 3],
    ['mjs', context.root, 'dist/core/upstream.mjs', 2],
    ['cjs', context.root, 'dist/core/upstream.cjs', 2],
    ['gateway', context.root, 'dist/domain/costs/gateway-manager.js', 3],
    ['wasm', context.piRoot, 'dist/utils/image-resize.js', 3],
  ];
  for (const [mode, root, file, line] of cases) {
    await t.test(`Node maps ${mode} to its exact prebundle JS line and column`, () => {
      const result = run(process.execPath, ['--enable-source-maps', path.join(stage, 'dist/entry/app.js'), mode], stage);
      frame(result, path.join(root, file), line, errorColumn(root, file, line));
    });
  }
}

async function checkVendorFrames(t, context, stage) {
  const cases = [
    ['vendor/pi/dist/codemode-worker.js', context.piRoot, 'dist/extensions/codemode/worker.js'],
    ['vendor/pi-ai/oauth-load.js', context.aiRoot, 'dist/auth/oauth/fixture.js'],
    ['vendor/pi-ai/bedrock.js', context.aiRoot, 'dist/api/bedrock-converse-stream.js'],
  ];
  for (const [entry, root, file] of cases) {
    await t.test(`Node maps ${entry} without upstream TS maps`, () => {
      const result = run(process.execPath, ['--enable-source-maps', path.join(stage, entry)], stage);
      frame(result, path.join(root, file), 2, 7);
    });
  }
}

test('local and release staging, runtime maps, and npm pack stay isolated', async t => {
  const context = fixture(t);
  addUpstreamMaps(context);
  const before = snapshot(context.root);
  const local = stageFixture(context, true);
  const release = stageFixture(context, false);
  await t.test('local maps are linked, embed readable JS and preserve the entry shebang', () => assertMaps(local));
  await checkFrames(t, context, local);
  await checkVendorFrames(t, context, local);
  await t.test('maps still resolve original JS after copying to an installed-package path', async nested => {
    const installed = path.join(context.cwd, 'installed/node_modules/fixture');
    fs.cpSync(local, installed, { recursive: true });
    await checkFrames(nested, context, installed);
    await checkVendorFrames(nested, context, installed);
  });
  await t.test('both manifests exclude all maps from actual npm tarballs', () => { assertPack(local); assertPack(release); });
  await t.test('release has no generated maps or sourceMappingURL links', () => {
    const generated = files(release).filter(file => file.endsWith('.js') && !file.includes('/client-bundle/'));
    for (const file of generated) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sourceMappingURL=/);
    assert(!files(release).some(file => file.endsWith('.js.map') && !file.includes('/client-bundle/')));
  });
  assert.deepEqual(snapshot(context.root), before, 'successful staging must not mutate any input');
});

test('a late worker failure only leaves a partial stage, never modified inputs', t => {
  const context = fixture(t);
  put(context.piRoot, 'dist/extensions/codemode/worker.js', 'import "./missing-worker-input.js";\n');
  const before = snapshot(context.root);
  const stage = path.join(context.cwd, 'partial');
  const result = run(process.execPath, ['scripts/bundle.mjs', '--sourcemap', stage], context.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-worker-input/);
  assert(fs.existsSync(path.join(stage, 'dist/entry/app.js')));
  assert.equal(fs.existsSync(path.join(stage, 'package.json')), false);
  assert.deepEqual(snapshot(context.root), before);
});

test('failed and reused stages never mutate source files or dependencies', t => {
  const context = fixture(t);
  put(context.root, 'dist/entry/app.js', 'import "./missing-fixture.js";\n');
  const before = snapshot(context.root);
  const stage = path.join(context.cwd, 'failed');
  const failed = run(process.execPath, ['scripts/bundle.mjs', stage, '--sourcemap'], context.root);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /missing-fixture/);
  assert.equal(fs.existsSync(stage), false);
  put(context.cwd, 'existing/sentinel', 'untouched');
  const existing = path.join(context.cwd, 'existing');
  const refused = run(process.execPath, ['scripts/bundle.mjs', existing, '--sourcemap'], context.root);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Stage already exists/);
  assert.equal(fs.readFileSync(path.join(existing, 'sentinel'), 'utf8'), 'untouched');
  assert.deepEqual(snapshot(context.root), before);
});
