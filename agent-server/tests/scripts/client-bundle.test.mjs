import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helperUrl = new URL('../../scripts/client-bundle.js', import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const files = ['client.mjs', 'cortex-run-watcher.mjs'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkgRoot = path.join(root, 'agent-server');
  fs.mkdirSync(pkgRoot);
  fs.mkdirSync(path.join(root, 'client/scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '**/dist/\n');
  fs.writeFileSync(path.join(root, 'client/package.json'), JSON.stringify({ type: 'module', version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'client/source.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'client/scripts/bundle.js'), `
    import fs from 'node:fs';
    fs.mkdirSync('dist', { recursive: true });
    fs.copyFileSync('source.js', 'dist/client.mjs');
    fs.writeFileSync('dist/cortex-run-watcher.mjs', 'process.exit(0);\\n');
  `);
  return { root, pkgRoot, dest: path.join(pkgRoot, 'dist/client-bundle') };
}

function commitFixture(root) {
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}

test('stages the ordered payload with client version and archive source unknown', async (t) => {
  const { stageClientBundle, validateClientBundle } = await import(helperUrl);
  const { pkgRoot, dest } = fixture(t);
  stageClientBundle(pkgRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json')));
  const bytes = Buffer.concat(files.map((name) => fs.readFileSync(path.join(dest, name))));
  assert.deepEqual(manifest, { version: '1.2.3', hash: hash(bytes), source: 'unknown' });
  assert.deepEqual(validateClientBundle(pkgRoot), manifest);
});

test('uses the current Node executable without npm or PATH shims', async (t) => {
  const { stageClientBundle } = await import(helperUrl);
  const { pkgRoot, dest } = fixture(t);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '/no-executables';
    stageClientBundle(pkgRoot);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.ok(fs.statSync(path.join(dest, 'client.mjs')).size > 0);
});

test('records only a clean checkout SHA; tracked and untracked dirt mean unknown', async (t) => {
  const { stageClientBundle } = await import(helperUrl);
  const { root, pkgRoot, dest } = fixture(t);
  const sha = commitFixture(root);
  const source = () => JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'))).source;
  stageClientBundle(pkgRoot);
  assert.equal(source(), sha);
  fs.writeFileSync(path.join(root, 'untracked'), 'dirty');
  stageClientBundle(pkgRoot);
  assert.equal(source(), 'unknown');
  fs.unlinkSync(path.join(root, 'untracked'));
  fs.appendFileSync(path.join(root, 'client/source.js'), '// modified\n');
  stageClientBundle(pkgRoot);
  assert.equal(source(), 'unknown');
});

for (const name of [...files, 'manifest.json']) {
  test(`rejects missing ${name}`, async (t) => {
    const { stageClientBundle, validateClientBundle } = await import(helperUrl);
    const { pkgRoot, dest } = fixture(t);
    stageClientBundle(pkgRoot);
    fs.unlinkSync(path.join(dest, name));
    assert.throws(() => validateClientBundle(pkgRoot));
  });
}

for (const manifest of [null, {}, { version: 1, hash: 'bad', source: 'unknown' },
  { version: '1.2.3', hash: 'a'.repeat(64), source: 'fabricated' }]) {
  test(`rejects invalid manifest ${JSON.stringify(manifest)}`, async (t) => {
    const { stageClientBundle, validateClientBundle } = await import(helperUrl);
    const { pkgRoot, dest } = fixture(t);
    stageClientBundle(pkgRoot);
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => validateClientBundle(pkgRoot), /manifest/i);
  });
}

for (const name of files) {
  test(`rejects tampered ${name} even with a recomputed manifest hash`, async (t) => {
    const { stageClientBundle, validateClientBundle } = await import(helperUrl);
    const { pkgRoot, dest } = fixture(t);
    stageClientBundle(pkgRoot);
    fs.appendFileSync(path.join(dest, name), '// tampered\n');
    assert.throws(() => validateClientBundle(pkgRoot), /hash/i);
    const manifestPath = path.join(dest, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.hash = hash(Buffer.concat(files.map((file) => fs.readFileSync(path.join(dest, file)))));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => validateClientBundle(pkgRoot), /stale/i);
  });
}

test('rejects stale source bytes even in a no-git archive', async (t) => {
  const { stageClientBundle, validateClientBundle } = await import(helperUrl);
  const { root, pkgRoot } = fixture(t);
  stageClientBundle(pkgRoot);
  fs.appendFileSync(path.join(root, 'client/source.js'), '// changed source\n');
  assert.throws(() => validateClientBundle(pkgRoot), /stale/i);
});

test('rejects stale client version and clean source SHA', async (t) => {
  const { stageClientBundle, validateClientBundle } = await import(helperUrl);
  const { root, pkgRoot } = fixture(t);
  commitFixture(root);
  stageClientBundle(pkgRoot);
  fs.writeFileSync(path.join(root, 'client/package.json'), JSON.stringify({ type: 'module', version: '2.0.0' }));
  assert.throws(() => validateClientBundle(pkgRoot), /stale/i);
  stageClientBundle(pkgRoot);
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'version');
  assert.throws(() => validateClientBundle(pkgRoot), /stale/i);
});

test('normal assets, prepack, and ignore-scripts publish all cover the payload', () => {
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
  assert.match(read('agent-server/scripts/copy-assets.js'), /stageClientBundle\(/);
  const pkg = JSON.parse(read('agent-server/package.json'));
  assert.match(pkg.scripts.prepack, /node scripts\/client-bundle\.js/);
  const workflow = read('.github/workflows/publish-server.yml');
  assert.match(workflow, /node scripts\/client-bundle\.js/);
  assert.ok(workflow.indexOf('node scripts/client-bundle.js') < workflow.indexOf('run: npm publish'));
});
