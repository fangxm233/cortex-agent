// input:  npm pack lifecycle, clean package fixture, native builder, empty npm cache
// output: offline-installable package with a packed 0755 supervisor and manifest digest
// pos:    Verifies the production package artifact from a clean tree
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = path.dirname(SERVER_ROOT);
const roots: string[] = [];

function excluded(relative: string): boolean {
  return relative === 'dist'
    || relative === 'node_modules'
    || relative === 'web/dist'
    || relative === 'native/cortex-supervisor/build'
    || relative === 'native/cortex-supervisor/dist'
    || relative.endsWith('.tgz');
}

function copyCleanPackage(root: string): string {
  const server = path.join(root, 'agent-server');
  fs.cpSync(SERVER_ROOT, server, {
    recursive: true,
    filter: source => !excluded(path.relative(SERVER_ROOT, source)),
  });
  fs.copyFileSync(path.join(REPO_ROOT, 'README.md'), path.join(root, 'README.md'));
  fs.mkdirSync(path.join(root, 'web/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/dist/index.html'), '<!doctype html>\n');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(server, 'node_modules'));
  return server;
}

function pack(server: string, destination: string): string {
  const previousUmask = process.umask(0o077);
  try {
    const result = spawnSync('npm', ['pack', '--pack-destination', destination], {
      cwd: server,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const tarballs = fs.readdirSync(destination).filter(file => file.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, `expected one tarball, got ${tarballs.join(', ')}`);
    return path.join(destination, tarballs[0]);
  } finally {
    process.umask(previousUmask);
  }
}

function extract(tarball: string, destination: string): string {
  fs.mkdirSync(destination);
  const result = spawnSync('tar', ['-xzf', tarball, '-C', destination], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return path.join(destination, 'package/native/cortex-supervisor/dist');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('npm pack produces an offline-installable package with a 0755 supervisor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-package-supervisor-'));
  roots.push(root);
  const server = copyCleanPackage(root);
  const supervisorDist = path.join(server, 'native/cortex-supervisor/dist');
  assert.equal(fs.existsSync(supervisorDist), false, 'fixture must not contain a stale build');

  const tarball = pack(server, root);
  const packedEntries = spawnSync('tar', ['-tzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(packedEntries.status, 0, packedEntries.stderr);
  const entries = new Set(packedEntries.stdout.trim().split('\n'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(server, 'package.json'), 'utf8'));
  const declaredDependencies = [
    ...Object.keys(packageJson.dependencies),
    ...Object.keys(packageJson.optionalDependencies),
  ].sort();
  assert.deepEqual([...packageJson.bundleDependencies].sort(), declaredDependencies);
  for (const dependency of packageJson.bundleDependencies) {
    assert.equal(
      entries.has(`package/node_modules/${dependency}/package.json`), true,
      `production tarball omitted ${dependency}`,
    );
  }
  const packedDist = extract(tarball, path.join(root, 'extracted'));
  const binary = path.join(packedDist, 'cortex-supervisor');
  const manifest = JSON.parse(fs.readFileSync(path.join(packedDist, 'build-manifest.json'), 'utf8'));
  const digest = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');

  assert.equal(fs.statSync(binary).mode & 0o777, 0o755);
  assert.equal(digest, manifest.binary_sha256);

  const prefix = path.join(root, 'installed');
  const cache = path.join(root, 'empty-cache');
  fs.mkdirSync(cache);
  const install = spawnSync('npm', [
    'install', '--global', '--prefix', prefix, '--cache', cache,
    '--offline', '--no-audit', '--no-fund', tarball,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const cliEnvironment = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' };
  delete cliEnvironment.NODE_PATH;
  const cli = spawnSync(path.join(prefix, 'bin/cortex'), ['agent-run', '--help'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: cliEnvironment,
  });
  assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
}, 300_000);
