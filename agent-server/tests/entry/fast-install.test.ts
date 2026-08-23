// input:  temporary repo/install trees and package manifests
// output: fast-install parity gating and staged-sync regression
// pos:    Verifies the dev hot-reload path that replaces npm pack + install -g
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planFastInstall, applyFastInstall, replaceDirectory } from '../../src/entry/fast-install.js';

const FILES = [
  'dist/',
  'defaults/',
  'web/dist/',
  'bundled-dependencies/',
  'scripts/install-bundled-dependencies.mjs',
  'scripts/postinstall-restart-trigger.mjs',
  'README.md',
];

const roots: string[] = [];

/** Build a repo checkout + install root pair that the fast path should accept. */
function makeTrees(overrides: { repoManifest?: object; installManifest?: object } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-install-'));
  roots.push(root);
  const monorepoRoot = path.join(root, 'monorepo');
  const repoDir = path.join(monorepoRoot, 'agent-server');
  const installRoot = path.join(root, 'install');

  const base = { name: '@cortex-agent/server', version: '2026.1.1', files: FILES, dependencies: { ws: '^8.0.0' } };

  fs.mkdirSync(path.join(repoDir, 'dist', 'entry'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'defaults'), { recursive: true });
  fs.mkdirSync(path.join(monorepoRoot, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'dist', 'entry', 'app.js'), 'new-build');
  fs.writeFileSync(path.join(repoDir, 'defaults', 'seed.json'), '{"v":2}');
  fs.writeFileSync(path.join(monorepoRoot, 'web', 'dist', 'index.html'), '<new/>');
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ ...base, ...(overrides.repoManifest ?? {}) }),
  );

  fs.mkdirSync(path.join(installRoot, 'dist', 'entry'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'node_modules', 'ws'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'dist', 'entry', 'app.js'), 'old-build');
  fs.writeFileSync(path.join(installRoot, 'dist', 'stale.js'), 'removed-by-sync');
  fs.writeFileSync(path.join(installRoot, 'node_modules', 'ws', 'index.js'), 'vendored');
  fs.writeFileSync(
    path.join(installRoot, 'package.json'),
    JSON.stringify({ ...base, ...(overrides.installManifest ?? {}) }),
  );

  return { repoDir, monorepoRoot, installRoot };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('planFastInstall accepts a src-only rebuild and lists every build output', () => {
  const dirs = makeTrees();

  const plan = planFastInstall(dirs);

  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.targets.map((t) => t.name), ['dist', 'defaults', 'web/dist']);
});

test('applyFastInstall replaces build outputs and leaves the vendored closure untouched', () => {
  const dirs = makeTrees();

  const synced = applyFastInstall(planFastInstall(dirs));

  assert.deepEqual(synced, ['dist', 'defaults', 'web/dist']);
  assert.equal(fs.readFileSync(path.join(dirs.installRoot, 'dist', 'entry', 'app.js'), 'utf8'), 'new-build');
  assert.equal(fs.readFileSync(path.join(dirs.installRoot, 'web', 'dist', 'index.html'), 'utf8'), '<new/>');
  // A replace, not a merge: files dropped from the build must not survive in the install root.
  assert.equal(fs.existsSync(path.join(dirs.installRoot, 'dist', 'stale.js')), false);
  // The whole point of the fast path — node_modules is never rewritten.
  assert.equal(fs.readFileSync(path.join(dirs.installRoot, 'node_modules', 'ws', 'index.js'), 'utf8'), 'vendored');
});

test('applyFastInstall copies the manifest so the next parity check sees the new version', () => {
  const dirs = makeTrees({ repoManifest: { version: '2026.9.9' } });

  applyFastInstall(planFastInstall(dirs));

  const installed = JSON.parse(fs.readFileSync(path.join(dirs.installRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, '2026.9.9');
});

test('planFastInstall refuses when the dependency closure changed', () => {
  const dirs = makeTrees({ repoManifest: { dependencies: { ws: '^8.0.0', yaml: '^2.0.0' } } });

  assert.equal(planFastInstall(dirs).blocked, 'dependency closure changed');
});

test('planFastInstall ignores dependency key ordering', () => {
  const dirs = makeTrees({
    repoManifest: { dependencies: { ws: '^8.0.0', yaml: '^2.0.0' } },
    installManifest: { dependencies: { yaml: '^2.0.0', ws: '^8.0.0' } },
  });

  assert.equal(planFastInstall(dirs).blocked, null);
});

test('planFastInstall refuses when package.json files grew an entry it cannot sync', () => {
  const dirs = makeTrees({ repoManifest: { files: [...FILES, 'assets/'] } });

  assert.match(planFastInstall(dirs).blocked ?? '', /`files` changed/);
});

test('planFastInstall refuses when the installed closure is missing', () => {
  const dirs = makeTrees();
  fs.rmSync(path.join(dirs.installRoot, 'node_modules'), { recursive: true, force: true });

  assert.equal(planFastInstall(dirs).blocked, 'installed node_modules missing');
});

test('planFastInstall refuses when the package was never installed', () => {
  const dirs = makeTrees();
  fs.rmSync(path.join(dirs.installRoot, 'package.json'));

  assert.match(planFastInstall(dirs).blocked ?? '', /never installed/);
});

test('applyFastInstall throws rather than syncing a blocked plan', () => {
  const dirs = makeTrees({ repoManifest: { dependencies: { ws: '^9.0.0' } } });

  assert.throws(() => applyFastInstall(planFastInstall(dirs)), /fast install blocked/);
});

test('replaceDirectory keeps the previous tree when the copy fails', () => {
  const dirs = makeTrees();
  const destination = path.join(dirs.installRoot, 'dist');

  assert.throws(() => replaceDirectory(path.join(dirs.repoDir, 'does-not-exist'), destination));

  assert.equal(fs.readFileSync(path.join(destination, 'entry', 'app.js'), 'utf8'), 'old-build');
  assert.equal(fs.readdirSync(dirs.installRoot).some((e) => e.includes('.cortex-fast-')), false);
});
